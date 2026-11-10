// Read-only official-host qualification. No production config or credentials.
// Build both repos first, then pass OPENCLAW_98_ROOT and POOL_RELAY_ROOT.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import net from "node:net";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL, fileURLToPath } from "node:url";
const run = promisify(execFile);
const host = process.env.OPENCLAW_98_ROOT;
const relay = process.env.POOL_RELAY_ROOT;
assert(host && relay, "Set OPENCLAW_98_ROOT and POOL_RELAY_ROOT");
assert.equal(
  JSON.parse(await fs.readFile(path.join(host, "package.json"), "utf8"))
    .version,
  "2026.9.8",
);
const plugin = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const root = await fs.mkdtemp(path.join(os.tmpdir(), "pool-98-gateway-"));
const state = path.join(root, "state");
await fs.mkdir(state, { recursive: true });
const configPath = path.join(state, "openclaw.json");
const listener = net.createServer();
await new Promise((r) => listener.listen(0, "127.0.0.1", r));
const port = listener.address().port;
await new Promise((r) => listener.close(r));
const env = {
  PATH: `${path.dirname(process.execPath)}:${path.dirname(host)}/.bin:/usr/bin:/bin`,
  HOME: path.join(root, "home"),
  OPENCLAW_STATE_DIR: state,
  OPENCLAW_CONFIG_PATH: configPath,
  OPENCLAW_AGENT_DIR: path.join(state, "agents/main/agent"),
  OPENCLAW_NO_RESPAWN: "1",
  OPENCLAW_GATEWAY_TOKEN: "synthetic-qualification-token-98",
  OPENAI_API_KEY: "synthetic-must-not-fund-inference",
};
const cfg = {
  gateway: {
    mode: "local",
    port,
    bind: "loopback",
    auth: { mode: "token", token: env.OPENCLAW_GATEWAY_TOKEN },
  },
  plugins: {
    allow: ["relay-channel", "openai"],
    load: { paths: [plugin] },
    entries: {
      "relay-channel": {
        enabled: true,
        hooks: { allowConversationAccess: true, allowPromptInjection: true },
      },
      openai: { enabled: true },
    },
  },
  agents: {
    defaults: {
      workspace: path.join(root, "workspace"),
      model: { primary: "openai/model", fallbacks: [] },
      params: { transport: "sse" },
    },
  },
  models: {
    providers: {
      openai: {
        api: "openai-chatgpt-responses",
        models: [
          {
            id: "model",
            name: "Synthetic qualification",
            contextWindow: 32000,
            maxTokens: 1024,
            agentRuntime: { id: "openclaw" },
          },
        ],
      },
    },
  },
};
await fs.writeFile(configPath, JSON.stringify(cfg));
const configBefore = await fs.readFile(configPath, "utf8");
const token = (accountId) =>
  [
    "synthetic",
    Buffer.from(
      JSON.stringify({
        "https://api.openai.com/auth": { chatgpt_account_id: accountId },
      }),
    ).toString("base64url"),
    "synthetic",
  ].join(".");
const members = ["a", "b"].map((accountId) => ({
  accountId,
  enabled: true,
  credentialVersion: 1,
  credential: {
    type: "oauth",
    provider: "openai",
    access: token(accountId),
    refresh: "synthetic",
    expires: 4700000000000,
    accountId,
  },
}));
env.POOL_98_TRANSPORT_LOG = path.join(root, "transport.jsonl");
await fs.writeFile(env.POOL_98_TRANSPORT_LOG, "");
env.NODE_OPTIONS = `--import=${pathToFileURL(path.join(plugin, "scripts/qualification/chatgpt-fixture.mjs")).href}`;
const savedEnv = { ...process.env };
Object.assign(process.env, env);
let gateway;
let logs = "";
try {
  const { writeRuntimeAuthPool } = await import(
    pathToFileURL(path.join(relay, "dist/agentControl/runtimeAuthWriter.js"))
      .href
  );
  const { prepareSubscriptionPool } = await import(
    pathToFileURL(
      path.join(relay, "dist/agentControl/openAiSubscriptionPool.js"),
    ).href
  );
  const pool = prepareSubscriptionPool(null, 1, members);
  await writeRuntimeAuthPool({ configPath, state: pool, members });
  await fs.writeFile(
    configPath + ".golem-openai-pool.json",
    JSON.stringify({ ...pool, phase: "applied" }),
  );
  const sdk = await import(
    pathToFileURL(path.join(host, "dist/plugin-sdk/provider-auth.js")).href
  );
  const read = () =>
    sdk.ensureAuthProfileStore(env.OPENCLAW_AGENT_DIR, {
      readOnly: true,
      syncExternalCli: false,
      allowKeychainPrompt: false,
      config: cfg,
    });
  assert.deepEqual(read().order.openai, ["openai:golem-a", "openai:golem-b"]);
  const db = path.join(state, "state/openclaw.sqlite");
  const beforeRead = await fs.readFile(db);
  read();
  assert.deepEqual(await fs.readFile(db), beforeRead);
  gateway = spawn(
    process.execPath,
    [
      path.join(host, "openclaw.mjs"),
      "gateway",
      "run",
      "--allow-unconfigured",
      "--port",
      String(port),
    ],
    { env, stdio: ["ignore", "pipe", "pipe"] },
  );
  gateway.stdout.on("data", (x) => (logs += x));
  gateway.stderr.on("data", (x) => (logs += x));
  const call = async (method, params = {}) => {
    const { stdout } = await run(
      process.execPath,
      [
        path.join(host, "openclaw.mjs"),
        "gateway",
        "call",
        method,
        "--params",
        JSON.stringify(params),
        "--json",
        "--url",
        `ws://127.0.0.1:${port}`,
        "--token",
        env.OPENCLAW_GATEWAY_TOKEN,
      ],
      { env, timeout: 15000, maxBuffer: 1024 * 1024 },
    );
    const result = JSON.parse(stdout);
    if (result.ok === false) throw Error(JSON.stringify(result));
    return result.result ?? result;
  };
  let status;
  for (let i = 0; i < 20; i++) {
    try {
      status = await call("relay-channel.subscriptionGuard.status");
      break;
    } catch {
      if (gateway.exitCode !== null)
        throw Error("Gateway exited: " + logs.slice(-4000));
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  assert.deepEqual(status, {
    version: 2,
    runScopedFallbacks: false,
    configuredFallbacksForbidden: true,
    readOnlyAdmission: true,
  });
  // The production guard with the actual 9.8 synchronous reader and hook runner.
  const { registerSubscriptionGuard } = await import(
    pathToFileURL(path.join(plugin, "dist/src/subscription-guard.js")).href
  );
  const hookFile = (await fs.readdir(path.join(host, "dist"))).find((x) =>
    /^hooks-.*\.mjs$/.test(x),
  );
  const { t: createHookRunner } = await import(
    pathToFileURL(path.join(host, "dist", hookFile)).href
  );
  const registry = { typedHooks: [] };
  registerSubscriptionGuard({
    config: cfg,
    runtime: {
      version: "2026.9.8",
      state: { resolveStateDir: () => state },
      config: { current: () => cfg },
      modelAuth: { ensureAuthProfileStore: sdk.ensureAuthProfileStore },
    },
    on: (hookName, handler, options) =>
      registry.typedHooks.push({
        pluginId: "relay-channel",
        hookName,
        handler,
        ...options,
      }),
    registerGatewayMethod: () => {},
  });
  const runner = createHookRunner(registry);
  const ctx = {
    agentId: "main",
    modelProviderId: "openai",
    modelId: "model",
    trigger: "cron",
  };
  assert.equal(
    (await runner.runBeforeAgentRun({}, ctx)).decision.outcome,
    "pass",
  );
  assert.equal(
    (await runner.runBeforeAgentRun({}, { ...ctx, modelId: "other" })).decision
      .outcome,
    "block",
  );
  cfg.agents.defaults.model.fallbacks = ["anthropic/paid"];
  assert.equal(
    (await runner.runBeforeAgentRun({}, ctx)).decision.outcome,
    "block",
  );
  cfg.agents.defaults.model.fallbacks = [];
  // Actual native inference with synthetic transport: A/429 must rotate to B,
  // never to the unrelated OPENAI_API_KEY. No real OAuth/network is used.
  const runTurn = async (session) => {
    try {
      const r = await run(
        process.execPath,
        [
          path.join(host, "openclaw.mjs"),
          "agent",
          "--agent",
          "main",
          "--session-id",
          session,
          "--message",
          "Synthetic pool qualification; do not run tools.",
          "--json",
          "--timeout",
          "30",
        ],
        { env, timeout: 45000, maxBuffer: 1024 * 1024 },
      );
      return r.stdout + " " + r.stderr;
    } catch (e) {
      return (e.stdout ?? "") + " " + (e.stderr ?? "");
    }
  };
  const healthy = await runTurn("pool-98-healthy");
  assert.match(
    healthy,
    /POOL_98_SYNTHETIC_B_OK/,
    "Expected actual Gateway A/429 to B rotation: " +
      healthy.slice(-3000) +
      " Gateway: " +
      logs.slice(-2000),
  );
  const dispatches = () =>
    fs.readFile(env.POOL_98_TRANSPORT_LOG, "utf8").then((s) =>
      s
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((s) => JSON.parse(s)),
    );
  const healthyCalls = await dispatches();
  const accounts = healthyCalls.filter((x) => x.account).map((x) => x.account);
  assert.equal(accounts[0], "a");
  assert.equal(accounts.at(-1), "b");
  assert(healthyCalls.some((x) => x.account === "a"));
  assert(healthyCalls.some((x) => x.account === "b"));
  assert(
    healthyCalls.every(
      (x) => ["a", "b"].includes(x.account) || x.blockedBackgroundUrl,
    ),
    JSON.stringify(healthyCalls),
  );
  const exhausted = members.map((m) => ({
    ...m,
    credentialVersion: 2,
    credential: { ...m.credential, expires: 1 },
  }));
  const next = prepareSubscriptionPool(pool, 2, exhausted);
  await fs.writeFile(
    configPath + ".golem-openai-pool.json",
    JSON.stringify({ ...next, phase: "pending" }),
  );
  await writeRuntimeAuthPool({ configPath, state: next, members: exhausted });
  await call("models.authStatus", { refresh: true });
  await fs.writeFile(
    configPath + ".golem-openai-pool.json",
    JSON.stringify({ ...next, phase: "applied" }),
  );
  assert.equal(
    (await runner.runBeforeAgentRun({}, ctx)).decision.outcome,
    "block",
  );
  // Actual Gateway turn: expired subscriptions must never reach inference.
  let turn = "";
  try {
    const result = await run(
      process.execPath,
      [
        path.join(host, "openclaw.mjs"),
        "agent",
        "--agent",
        "main",
        "--session-id",
        "pool-98-exhausted",
        "--message",
        "Synthetic exhausted pool qualification; do not run tools.",
        "--json",
        "--timeout",
        "20",
      ],
      { env, timeout: 30000, maxBuffer: 1024 * 1024 },
    );
    turn = result.stdout + " " + result.stderr;
  } catch (e) {
    turn = (e.stdout ?? "") + " " + (e.stderr ?? "");
  }
  assert.match(
    turn,
    /OPENAI_SUBSCRIPTIONS|subscription-only|golem-subscription-denied|unavailable/i,
    "Expected explicit subscription refusal, not a provider reply",
  );
  const finalCalls = await dispatches();
  assert(
    finalCalls.every(
      (x) => ["a", "b"].includes(x.account) || x.blockedBackgroundUrl,
    ),
    JSON.stringify(finalCalls),
  );
  assert.deepEqual(
    finalCalls.filter((x) => x.account),
    healthyCalls.filter((x) => x.account),
    "An exhausted pool must not dispatch any inference request",
  );
  assert.equal(await fs.readFile(configPath, "utf8"), configBefore);
  console.log(
    JSON.stringify(
      {
        host: "2026.9.8",
        guard: status,
        actualSdkPoolAB: true,
        actualGatewaySyntheticA429ToB: true,
        readOnlyStorePreserved: true,
        actualHostHookAllow: true,
        injectedOtherModelBlocked: true,
        configuredFallbackBlocked: true,
        exhaustedPoolBlocked: true,
        actualGatewayTurnRefused: true,
        authoredConfigPreserved: true,
        realOAuthInference: false,
      },
      null,
      2,
    ),
  );
} finally {
  if (gateway && gateway.exitCode === null) {
    gateway.kill("SIGTERM");
    await Promise.race([
      new Promise((r) => gateway.once("close", r)),
      new Promise((r) =>
        setTimeout(() => {
          gateway.kill("SIGKILL");
          r();
        }, 5000),
      ),
    ]);
  }
  for (const k of Object.keys(process.env))
    if (!(k in savedEnv)) delete process.env[k];
  Object.assign(process.env, savedEnv);
  await fs.rm(root, { recursive: true, force: true });
}
