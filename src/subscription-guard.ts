import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { OpenClawPluginApi } from "../openclaw-sdk.js";

const memberSchema = z.object({
  accountId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  profileId: z.string(), enabled: z.boolean(),
});
const poolSchema = z.object({
  version: z.literal(1), revision: z.number().int().positive(),
  phase: z.enum(["pending", "applied"]), members: z.array(memberSchema).max(32),
});
type Pool = z.infer<typeof poolSchema>;
type Context = { agentId?: string; modelProviderId?: string; modelId?: string; trigger?: string };
type Store = { profiles: Record<string, Record<string, unknown>>; usageStats?: Record<string, Record<string, unknown>> };
type ModelAuth = {
  ensureAuthProfileStoreAsync?: (agentDir: string, options: Record<string, unknown>) => Promise<Store>;
  ensureAuthProfileStore?: (agentDir: string, options: Record<string, unknown>) => Store;
};
type Runtime = { modelAuth?: ModelAuth; state?: { resolveStateDir(): string }; version?: string; agent?: {resolveAgentDir(config: Record<string, unknown>, agentId: string): string}; config?: {current(): Record<string, unknown>} };
const record = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const denied = "OPENAI_SUBSCRIPTIONS_UNAVAILABLE: subscription-only inference refused; reconnect an enabled subscription or update this agent. No API-key/credits fallback was requested.";

export function poolGuardStatePath(configPath: string): string {
  return configPath === "/root/.openclaw/openclaw.json" ? "/var/lib/golem-workers/openai-subscription-pool.json" : configPath + ".golem-openai-pool.json";
}

/** Pure admission: never refresh credentials, patch sessions, or rewrite model/Harness configuration. */
export function assertPoolAdmission(pool: Pool, store: Store, config: Record<string, unknown>, ctx: Context, now = Date.now(), requireSelectedModel = false): void {
  if (pool.phase !== "applied") throw new Error("OPENAI_POOL_PENDING");
  const appServer = record(record(record(record(record(config.plugins).entries).codex).config).appServer);
  if (appServer.homeScope === "user" || (appServer.transport !== undefined && appServer.transport !== "stdio") || appServer.url) throw new Error("OPENAI_POOL_CODEX_AUTH_OWNER_UNSUPPORTED");
  const agents = record(config.agents), defaults = record(agents.defaults);
  const agent = (Array.isArray(agents.list) ? agents.list.map(record) : []).find(a => a.id === (ctx.agentId ?? "main")) ?? record(record(agents.entries)[ctx.agentId ?? "main"]);
  const assignment = agent.model ?? defaults.model;
  const primary = typeof assignment === "string" ? assignment : record(assignment).primary;
  const provider = ctx.modelProviderId ?? (typeof primary === "string" ? primary.split("/")[0] : "");
  const modelId = ctx.modelId ?? (typeof primary === "string" ? primary.slice(primary.indexOf("/") + 1) : "");
  if (requireSelectedModel && primary !== `${provider}/${modelId}`) throw new Error("OPENAI_POOL_ROUTE_UNSUPPORTED");
  if (provider !== "openai" || !modelId) throw new Error("OPENAI_POOL_ROUTE_UNSUPPORTED");
  const providerConfig = record(record(record(config.models).providers).openai);
  const row = (Array.isArray(providerConfig.models) ? providerConfig.models.map(record) : []).find(m => m.id === modelId) ?? {};
  const ref = `openai/${modelId}`;
  const catalog = { ...record(record(defaults.models)[ref]), ...record(record(agent.models)[ref]) };
  const route = { ...providerConfig, ...row, ...catalog };
  const env = { ...process.env, ...record(config.env), ...record(record(config.env).vars) };
  // 9.8 normalizes an omitted baseUrl to an empty string; its ChatGPT
  // transport treats that exact value as the canonical subscription endpoint.
  const endpoint = requireSelectedModel && route.baseUrl === "" ? undefined : route.baseUrl;
  if (route.api !== "openai-chatgpt-responses" || !/^https:\/\/chatgpt\.com\/backend-api\/codex\/?$/.test(String(endpoint ?? env.OPENAI_BASE_URL ?? "https://chatgpt.com/backend-api/codex")) || [providerConfig, row, catalog, defaults, agent, record(record(config.providers).openai)].some(r => r.auth !== undefined || r.apiKey !== undefined)) throw new Error("OPENAI_POOL_ROUTE_UNSUPPORTED");
  const enabled = new Set(pool.members.filter(m => m.enabled).map(m => m.profileId));
  for (const m of pool.members) if (m.profileId !== `openai:golem-${m.accountId}`) throw new Error("OPENAI_POOL_ID_INVALID");
  // Runtime repairs stale order by scanning compatible profiles. Refuse foreign
  // OAuth/token profiles rather than silently deleting them or trusting order.
  for (const [id, credential] of Object.entries(store.profiles)) {
    if (["openai", "openai-codex"].includes(String(credential.provider)) && ["oauth", "token"].includes(String(credential.type)) && (!enabled.has(id) || credential.type !== "oauth")) throw new Error("OPENAI_POOL_UNMANAGED_SUBSCRIPTION");
  }
  const eligible = [...enabled].some(id => {
    const c = store.profiles[id], s = store.usageStats?.[id] ?? {};
    const otherModel = s.cooldownModel && s.cooldownModel !== modelId && ["rate_limit", "timeout"].includes(String(s.cooldownReason));
    return c?.type === "oauth" && c.provider === "openai" && typeof c.access === "string" && c.access.length > 0 && typeof c.expires === "number" && c.expires > now && !(Number(s.blockedUntil) > now || Number(s.disabledUntil) > now || (!otherModel && Number(s.cooldownUntil) > now));
  });
  if (!eligible) throw new Error("OPENAI_SUBSCRIPTIONS_EXHAUSTED");
}

/** 9.8 cannot suppress a run's outer fallback chain. Refuse authored fallback
 * sources (including nested/subagent/cron settings), never rewrite user config. */
export function assertNoConfiguredFallbacks(value: unknown): void {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if ((key === "fallback" || key === "fallbacks") && child != null &&
        !(Array.isArray(child) && child.length === 0) && child !== "") {
      throw new Error("OPENAI_POOL_MODEL_FALLBACK_FORBIDDEN");
    }
    assertNoConfiguredFallbacks(child);
  }
}

export function registerSubscriptionGuard(api: OpenClawPluginApi): void {
  const runtime = api.runtime as Runtime;
  const version = runtime.version?.match(/^(\d+)\.(\d+)\.(\d+)/)?.slice(1).map(Number);
  const supportedHost = version && (version[0] > 2026 || (version[0] === 2026 && (version[1] > 11 || (version[1] === 11 && version[2] >= 2))));
  const legacyHost = version?.[0] === 2026 && version[1] === 9 && version[2] === 8;
  const hookPolicy = record(record(record(record(api.config).plugins).entries)["relay-channel"]).hooks;
  const hooks = record(hookPolicy);
  const supported = hooks.allowConversationAccess === true && hooks.allowPromptInjection !== false && (supportedHost || legacyHost) && typeof api.on === "function" && (legacyHost ? typeof runtime.modelAuth?.ensureAuthProfileStore === "function" : typeof runtime.modelAuth?.ensureAuthProfileStoreAsync === "function") && typeof runtime.state?.resolveStateDir === "function";
  if (!supported) return; // No capability RPC: Relay refuses unsupported hosts before auth effects.
  const stateDir = runtime.state!.resolveStateDir();
  const configPath = process.env.OPENCLAW_CONFIG_PATH ?? path.join(stateDir, "openclaw.json");
  let seenPool = false;
  const readPool = async (): Promise<Pool | null> => {
    try {
      const raw = await fs.readFile(poolGuardStatePath(configPath), "utf8");
      seenPool = true;
      if (raw.length > 1024 * 1024) throw new Error("OPENAI_POOL_INVALID");
      return poolSchema.parse(JSON.parse(raw));
    } catch (error) {
      if (!seenPool && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  };
  const check = async (ctx: Context): Promise<"unmanaged" | "allowed" | "denied"> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        (async () => {
          const pool = await readPool();
          if (!pool) return "unmanaged" as const;
          const id = ctx.agentId ?? "main";
          if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error("OPENAI_POOL_AGENT_UNSUPPORTED");
          const cfg = runtime.config?.current() ?? api.config ?? {};
          const agents = record(cfg.agents);
          const agent = (Array.isArray(agents.list) ? agents.list.map(record) : []).find(a => a.id === id) ?? record(record(agents.entries)[id]);
          const agentDir = runtime.agent?.resolveAgentDir(cfg, id) ?? (typeof agent.agentDir === "string" ? agent.agentDir : path.join(stateDir, "agents", id, "agent"));
          if (legacyHost) assertNoConfiguredFallbacks(cfg);
          const options = { readOnly: true, syncExternalCli: false, allowKeychainPrompt: false, config: cfg };
          const store = legacyHost
            ? runtime.modelAuth!.ensureAuthProfileStore!(agentDir, options)
            : await runtime.modelAuth!.ensureAuthProfileStoreAsync!(agentDir, options);
          assertPoolAdmission(pool, store, cfg, ctx, Date.now(), legacyHost);
          return "allowed" as const;
        })(),
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("OPENAI_POOL_ADMISSION_TIMEOUT")), 2000); }),
      ]);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      const code = /^(?:OPENAI_POOL|OPENAI_SUBSCRIPTIONS)_[A-Z_]+$/.test(message) ? message : "OPENAI_POOL_READ_FAILED";
      console.warn(`[relay-channel] subscription admission denied: ${code}`);
      return "denied";
    }
    finally { if (timer) clearTimeout(timer); }
  };
  api.on!("before_model_resolve", async (_event, ctx) => {
    const outcome = await check(ctx);
    if (outcome === "unmanaged") return;
    // An invalid, plugin-owned route is deliberate fail-closed admission on
    // hosts which skip before_agent_reply for an unclassified trigger.
    return outcome === "denied" ? { providerOverride: "golem-subscription-denied", modelOverride: "unavailable", fallbacksOverride: [] } : { fallbacksOverride: [] };
  }, { priority: 1000000 });
  api.on!("before_agent_reply", async (_event, ctx) => (await check(ctx)) === "denied" ? { handled: true, reply: { text: denied }, reason: "subscription-only-admission" } : { handled: false }, { priority: 1000000 });
  api.on!("before_agent_run", async (_event, ctx) => {
    const outcome = await check(ctx);
    if (legacyHost) return outcome === "denied" ? { outcome: "block", reason: "subscription-only-admission", message: denied } : { outcome: "pass" };
    if (outcome === "denied") throw new Error(denied);
  }, { priority: 1000000 });
  api.registerGatewayMethod?.("relay-channel.subscriptionGuard.status", ({ respond }) => {
    respond(true, legacyHost
      ? { version: 2, runScopedFallbacks: false, configuredFallbacksForbidden: true, readOnlyAdmission: true }
      : { version: 1, runScopedFallbacks: true, readOnlyAdmission: true });
  }, { scope: "operator.read" });
}
