import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertNoConfiguredFallbacks, assertPoolAdmission, poolGuardStatePath, registerSubscriptionGuard } from "./subscription-guard.js";
import type { OpenClawPluginApi } from "../openclaw-sdk.js";
const now = 1800000000000;
const pool = {version:1 as const,revision:1,phase:"applied" as const,members:[{accountId:"a",profileId:"openai:golem-a",enabled:true},{accountId:"b",profileId:"openai:golem-b",enabled:true}]};
const config = {plugins:{entries:{"relay-channel":{hooks:{allowConversationAccess:true}}}},agents:{defaults:{model:{primary:"openai/model",fallbacks:["anthropic/paid"]}}},models:{providers:{openai:{api:"openai-chatgpt-responses",models:[{id:"model"}]}}}};
const profile = {type:"oauth",provider:"openai",access:"synthetic",expires:now+100000};
const store = () => ({profiles:{"openai:golem-a":{...profile},"openai:golem-b":{...profile},"openai:api":{type:"api_key",provider:"openai",key:"synthetic-api"}} as Record<string,Record<string,unknown>>,usageStats:{} as Record<string,Record<string,unknown>>});
const roots: string[]=[];
const oldConfigPath = process.env.OPENCLAW_CONFIG_PATH;
afterEach(async()=>{if(oldConfigPath===undefined)delete process.env.OPENCLAW_CONFIG_PATH;else process.env.OPENCLAW_CONFIG_PATH=oldConfigPath;await Promise.all(roots.splice(0).map(p=>fs.rm(p,{recursive:true,force:true})));});
describe("pure subscription admission",()=>{
 it("allows B after A cooldown without changing retained credentials or authored fallbacks",()=>{const s=store();s.usageStats["openai:golem-a"]={cooldownUntil:now+50000};const before=structuredClone({s,config});assertPoolAdmission(pool,s,config,{},now);expect({s,config}).toEqual(before);});
 it.each(["cooldownUntil","disabledUntil","blockedUntil"])("refuses exhausted %s before inference",key=>{const s=store();for(const id of ["openai:golem-a","openai:golem-b"])s.usageStats[id]={[key]:now+1};expect(()=>assertPoolAdmission(pool,s,config,{},now)).toThrow("EXHAUSTED");});
 it("refuses expired OAuth despite API credentials",()=>{const s=store();s.profiles["openai:golem-a"].expires=1;s.profiles["openai:golem-b"].expires=1;expect(()=>assertPoolAdmission(pool,s,config,{},now)).toThrow("EXHAUSTED");});
 it.each(["oauth","token"])("refuses foreign %s even when the runtime could repair stale order",type=>{const s=store();s.profiles.foreign={...profile,type};expect(()=>assertPoolAdmission(pool,s,config,{},now)).toThrow("UNMANAGED");});
 it("refuses disabled residual profiles",()=>expect(()=>assertPoolAdmission({...pool,members:pool.members.map(m=>({...m,enabled:false}))},store(),config,{},now)).toThrow("UNMANAGED"));
 it("refuses partial apply and a non-pool provider override",()=>{expect(()=>assertPoolAdmission({...pool,phase:"pending"},store(),config,{},now)).toThrow("PENDING");expect(()=>assertPoolAdmission(pool,store(),config,{modelProviderId:"anthropic",modelId:"paid"},now)).toThrow("ROUTE_UNSUPPORTED");});
 it.each([{api:"openai-responses"},{api:"openai-chatgpt-responses",baseUrl:"https://api.openai.com/v1"},{api:"openai-chatgpt-responses",apiKey:"synthetic"}])("refuses API-key or endpoint route %j",route=>{const c=structuredClone(config);Object.assign(c.models.providers.openai,route);expect(()=>assertPoolAdmission(pool,store(),c,{},now)).toThrow("ROUTE_UNSUPPORTED");});
});
async function fixture(legacy = false, version = legacy ? "2026.9.8" : "2026.11.2", asyncReader = !legacy){const root=await fs.mkdtemp(path.join(os.tmpdir(),"pool-plugin-guard-"));roots.push(root);process.env.OPENCLAW_CONFIG_PATH=path.join(root,"openclaw.json");const hooks=new Map<string,Parameters<NonNullable<OpenClawPluginApi["on"]>>[1]>();let rpc:Parameters<NonNullable<OpenClawPluginApi["registerGatewayMethod"]>>[1]|undefined;const s=store();for(const c of Object.values(s.profiles))if(c.type==="oauth")c.expires=Date.now()+100000;const cfg=structuredClone(config);if(legacy)cfg.agents.defaults.model.fallbacks=[];const reads:string[]=[];const api:OpenClawPluginApi={config:cfg,runtime:{version,state:{resolveStateDir:()=>root},modelAuth:{[asyncReader ? "ensureAuthProfileStoreAsync" : "ensureAuthProfileStore"]:(dir:string,opts:unknown)=>{reads.push(dir);expect(opts).toMatchObject({readOnly:true,syncExternalCli:false,allowKeychainPrompt:false});return asyncReader ? Promise.resolve(s) : s;}}},registerChannel:()=>{},on:(name,handler)=>{hooks.set(name,handler);},registerGatewayMethod:(_name,handler)=>{rpc=handler;}};registerSubscriptionGuard(api);const write=(p:unknown)=>fs.writeFile(poolGuardStatePath(process.env.OPENCLAW_CONFIG_PATH!),JSON.stringify(p));return {root,hooks,s,cfg,reads,write,rpc,api};}
describe("registered guard hooks",()=>{
 it("does not affect unmanaged agents",async()=>{const f=await fixture();expect(await f.hooks.get("before_model_resolve")!({},{})).toBeUndefined();expect(f.reads).toEqual([]);});
 it("suppresses only the run chain, including nested-agent selection",async()=>{const f=await fixture();await f.write(pool);const before=structuredClone(f.cfg);expect(await f.hooks.get("before_model_resolve")!({},{agentId:"child"})).toEqual({fallbacksOverride:[]});expect(f.reads).toEqual([path.join(f.root,"agents/child/agent")]);expect(f.cfg).toEqual(before);expect(await f.hooks.get("before_agent_reply")!({},{trigger:"cron"})).toEqual({handled:false});});
 it.each(["pending","exhausted","malformed"])("fails closed for %s, including unknown triggers",async kind=>{const f=await fixture();if(kind==="pending")await f.write({...pool,phase:"pending"});else if(kind==="malformed")await f.write({version:42});else{await f.write(pool);for(const id of pool.members.map(m=>m.profileId))f.s.usageStats[id]={cooldownUntil:Date.now()+10000};}expect(await f.hooks.get("before_model_resolve")!({},{trigger:"unknown"})).toEqual({providerOverride:"golem-subscription-denied",modelOverride:"unavailable",fallbacksOverride:[]});expect(await f.hooks.get("before_agent_reply")!({},{})).toMatchObject({handled:true,reason:"subscription-only-admission"});expect(await f.hooks.get("before_agent_run")!({},{})).toMatchObject({outcome:"block",message:expect.stringContaining("SUBSCRIPTIONS_UNAVAILABLE")});});
 it("refuses disappearance after activation rather than treating it as unmanaged",async()=>{const f=await fixture();await f.write(pool);await f.hooks.get("before_model_resolve")!({},{});await fs.rm(poolGuardStatePath(process.env.OPENCLAW_CONFIG_PATH!));expect(await f.hooks.get("before_agent_reply")!({},{})).toMatchObject({handled:true});});
 it("denies SDK failures without logging raw error details",async()=>{
  const f=await fixture();await f.write(pool);
  (f.api.runtime as {modelAuth: {ensureAuthProfileStoreAsync:()=>Promise<never>}}).modelAuth.ensureAuthProfileStoreAsync=async()=>{throw Error("synthetic-private-credential-detail");};
  const warning=vi.spyOn(console,"warn").mockImplementation(()=>{});
  try{expect(await f.hooks.get("before_agent_reply")!({},{})).toMatchObject({handled:true});expect(warning).toHaveBeenCalledWith("[relay-channel] subscription admission denied: OPENAI_POOL_READ_FAILED");expect(JSON.stringify(warning.mock.calls)).not.toContain("synthetic-private-credential-detail");}finally{warning.mockRestore();}
 });
 it("does not advertise hooks blocked by host conversation-access consent",()=>{registerSubscriptionGuard({config:{},runtime:{version:"2026.11.2",state:{resolveStateDir:()=>"/tmp/unused"},modelAuth:{ensureAuthProfileStoreAsync:()=>{throw Error("must not read");}}},registerChannel:()=>{},on:()=>{throw Error("must not register");},registerGatewayMethod:()=>{throw Error("must not advertise");}});});
 it("does not advertise capability without public read-only SDK support",()=>{const on=()=>{throw Error("must not register");};registerSubscriptionGuard({runtime:{},registerChannel:()=>{},on,registerGatewayMethod:()=>{throw Error("must not advertise");}});});
 it("advertises the loaded guard without disclosing profiles or tokens",async()=>{const f=await fixture();const responses:unknown[]=[];f.rpc!({respond:(_ok,p)=>responses.push(p)});expect(responses).toEqual([{version:1,runScopedFallbacks:true,readOnlyAdmission:true,poolExitVersion:1}]);});
});


describe("official 2026.9.8 strict adapter", () => {
  it("accepts the host-normalized empty default endpoint without admitting custom endpoints", () => {
    const cfg = structuredClone(config); Object.assign(cfg.models.providers.openai, {baseUrl:""});
    expect(()=>assertPoolAdmission(pool,store(),cfg,{},now,true)).not.toThrow();
    expect(()=>assertPoolAdmission(pool,store(),cfg,{},now)).not.toThrow();
    Object.assign(cfg.models.providers.openai,{baseUrl:"https://api.openai.com/v1"});
    expect(()=>assertPoolAdmission(pool,store(),cfg,{},now,true)).toThrow("ROUTE_UNSUPPORTED");
  });
  it("uses the read-only synchronous SDK and advertises only strict mode", async () => {
    const f = await fixture(true); await f.write(pool);
    const responses: unknown[] = []; f.rpc!({respond: (_ok,p) => responses.push(p)});
    expect(responses).toEqual([{version:2,runScopedFallbacks:false,configuredFallbacksForbidden:true,readOnlyAdmission:true,poolExitVersion:1}]);
    const before = structuredClone({config:f.cfg,store:f.s});
    expect(await f.hooks.get("before_agent_run")!({}, {modelProviderId:"openai",modelId:"model"})).toEqual({outcome:"pass"});
    expect(f.reads).toHaveLength(1); expect({config:f.cfg,store:f.s}).toEqual(before);
  });
  it("denies fallback sources added after enrollment without config or credential mutation", async () => {
    const f = await fixture(true); await f.write(pool);
    f.cfg.agents.defaults.model.fallbacks.push("anthropic/paid");
    expect(await f.hooks.get("before_agent_run")!({},{})).toMatchObject({outcome:"block"});
    expect(f.reads).toHaveLength(0); expect(f.cfg.agents.defaults.model.fallbacks).toEqual(["anthropic/paid"]);
  });
  it("blocks injected cron/session candidates even with no authored fallback", async () => {
    const f = await fixture(true); await f.write(pool);
    for (const [modelProviderId,modelId] of [["anthropic","paid"],["openai","other"]]) {
      expect(await f.hooks.get("before_agent_run")!({}, {modelProviderId,modelId,trigger:"cron"})).toMatchObject({outcome:"block"});
    }
  });
  it("blocks exhausted pools at the actual run gate", async () => {
    const f = await fixture(true); await f.write(pool);
    for(const id of pool.members.map(m=>m.profileId))f.s.usageStats[id]={cooldownUntil:Date.now()+10000};
    expect(await f.hooks.get("before_agent_run")!({},{})).toMatchObject({outcome:"block"});
  });
  it("allows unmanaged runs through the legacy decision-shaped gate", async () => {
    const f = await fixture(true);
    expect(await f.hooks.get("before_agent_run")!({},{})).toEqual({outcome:"pass"});
    expect(f.reads).toEqual([]);
  });
  it.each([{agents:{defaults:{subagents:{model:{fallbacks:["paid/model"]}}}}},{cron:{payload:{fallbacks:["openai/other"]}}},{agents:{entries:{child:{model:{fallback:"paid/model"}}}}}])("rejects nested fallback configuration %j", cfg => {
    expect(()=>assertNoConfiguredFallbacks(cfg)).toThrow("MODEL_FALLBACK_FORBIDDEN");
  });
});

describe("continuous supported host range", () => {
  it.each(["2026.9.8","2026.9.9","2026.9.33","2026.9.34","2026.9.35","2026.9.36","2026.10.1","2026.10.2","2026.10.3","2026.10.4","2026.10.5","2026.10.6","2026.10.7","2026.10.8","2026.10.9","2026.10.10","2026.11.1"])("supports intermediate host %s with strict proof", async version => {
    for (const asyncReader of [false,true]) {
      const f=await fixture(true,version,asyncReader);await f.write(pool);const responses:unknown[]=[];
      f.rpc!({respond:(_ok,p)=>responses.push(p)});
      expect(responses).toEqual([{version:2,runScopedFallbacks:false,configuredFallbacksForbidden:true,readOnlyAdmission:true,poolExitVersion:1}]);
      expect(await f.hooks.get("before_agent_run")!({},{})).toEqual({outcome:"pass"});expect(f.reads).toHaveLength(1);
      f.cfg.agents.defaults.model.fallbacks.push("anthropic/paid");
      expect(await f.hooks.get("before_agent_run")!({},{})).toMatchObject({outcome:"block"});
    }
  });
  it.each(["2026.11.2","2026.12.1","2027.1.1"])("uses modern proof with async public SDK on %s",async version=>{
    const f=await fixture(false,version);await f.write(pool);const responses:unknown[]=[];f.rpc!({respond:(_ok,p)=>responses.push(p)});
    expect(responses).toEqual([{version:1,runScopedFallbacks:true,readOnlyAdmission:true,poolExitVersion:1}]);
    expect(await f.hooks.get("before_agent_run")!({},{})).toEqual({outcome:"pass"});
    expect(await f.hooks.get("before_model_resolve")!({},{})).toEqual({fallbacksOverride:[]});
  });
  it("uses strict proof on a newer host with only the synchronous public SDK",async()=>{
    const f=await fixture(true,"2026.11.2",false);await f.write(pool);const responses:unknown[]=[];f.rpc!({respond:(_ok,p)=>responses.push(p)});
    expect(responses).toEqual([{version:2,runScopedFallbacks:false,configuredFallbacksForbidden:true,readOnlyAdmission:true,poolExitVersion:1}]);
    expect(await f.hooks.get("before_agent_run")!({},{})).toEqual({outcome:"pass"});
  });
  it.each(["2026.8.99","2026.9.7","2025.12.31","unknown"])("does not qualify below-minimum/unknown host %s", async version => {
    const f=await fixture(true);const on=vi.fn(),registerGatewayMethod=vi.fn();
    registerSubscriptionGuard({...f.api,runtime:{...f.api.runtime,version},on,registerGatewayMethod});
    expect(on).not.toHaveBeenCalled();expect(registerGatewayMethod).not.toHaveBeenCalled();
  });
  it.each(["2026.9.8","2026.10.10","2026.11.2","2027.1.1"])("does not advertise %s without either public auth reader",async version=>{
    const f=await fixture(true);const on=vi.fn(),registerGatewayMethod=vi.fn();
    registerSubscriptionGuard({...f.api,runtime:{...f.api.runtime,version,modelAuth:{}},on,registerGatewayMethod});
    expect(on).not.toHaveBeenCalled();expect(registerGatewayMethod).not.toHaveBeenCalled();
  });
});

it("does not treat memory, Harness or transport fallback as model fallback",()=>{
 expect(()=>assertNoConfiguredFallbacks({agents:{defaults:{model:{primary:"openai/model",fallbacks:[]},memorySearch:{fallback:"none"}}},plugins:{entries:{codex:{config:{fallback:"openclaw"}}}},channels:{fallback:"keep"}})).not.toThrow();
});


describe("revisioned pool exit admission", () => {
 it("releases only the completed empty tombstone, never reads OAuth or suppresses API fallbacks", async () => {
  const f=await fixture(true); await f.write({...pool,phase:"exited",members:[],managedProfileIds:[]});
  expect(await f.hooks.get("before_model_resolve")!({},{})).toBeUndefined();
  expect(await f.hooks.get("before_agent_run")!({},{})).toEqual({outcome:"pass"});
  expect(f.reads).toEqual([]);
  await fs.rm(poolGuardStatePath(process.env.OPENCLAW_CONFIG_PATH!));
  expect(await f.hooks.get("before_agent_run")!({},{})).toMatchObject({outcome:"block"});
 });
 it.each([{phase:"exiting",members:[],managedProfileIds:[]},{phase:"exited",members:pool.members,managedProfileIds:[]},{phase:"exited",members:[],managedProfileIds:["openai:golem-a"]},{phase:"exited",members:[]}])("keeps partial or malformed exit fail-closed %j", async patch => {
  const f=await fixture(); await f.write({...pool,...patch});
  expect(await f.hooks.get("before_agent_run")!({},{})).toMatchObject({outcome:"block"});
 });
});
