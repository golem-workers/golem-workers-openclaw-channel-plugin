// Read-only official-host qualification. No production config or credentials.
// Build both repos first, then pass OPENCLAW_ROOT and POOL_RELAY_ROOT.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import net from "node:net";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL, fileURLToPath } from "node:url";
const run = promisify(execFile);
const host = process.env.OPENCLAW_ROOT ?? process.env.OPENCLAW_98_ROOT;
const relay = process.env.POOL_RELAY_ROOT;
assert(host && relay, "Set OPENCLAW_ROOT and POOL_RELAY_ROOT");
const hostVersion = JSON.parse(
  await fs.readFile(path.join(host, "package.json"), "utf8"),
).version;
const version = hostVersion.split(".").map(Number);
assert(
  version[0] > 2026 ||
    (version[0] === 2026 &&
      (version[1] > 9 || (version[1] === 9 && version[2] >= 8))),
  "Minimum official host is 2026.9.8",
);
const modernHost =
  version[0] > 2026 ||
  (version[0] === 2026 &&
    (version[1] > 11 || (version[1] === 11 && version[2] >= 2)));
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
      model: {
        primary: "openai/model",
        fallbacks: ["anthropic/paid"],
      },
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
  const sdk = await import(
    pathToFileURL(path.join(host, "dist/plugin-sdk/provider-auth.js")).href
  );
  const authReader =
    sdk.ensureAuthProfileStoreAsync ?? sdk.ensureAuthProfileStore;
  assert.equal(typeof authReader, "function");
  const strict = !(modernHost && sdk.ensureAuthProfileStoreAsync);
  const read = async () =>
    authReader(env.OPENCLAW_AGENT_DIR, {
      readOnly: true,
      syncExternalCli: false,
      allowKeychainPrompt: false,
      config: cfg,
    });
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
  assert.deepEqual(
    status,
    strict
      ? {
          version: 2,
          runScopedFallbacks: false,
          configuredFallbacksForbidden: true,
          readOnlyAdmission: true,
        }
      : { version: 1, runScopedFallbacks: true, readOnlyAdmission: true },
  );
  const { syncSubscriptionPool } = await import(
    pathToFileURL(
      path.join(relay, "dist/agentControl/subscriptionPoolManager.js"),
    ).href
  );
  const { refreshSubscriptionPoolAuth, waitForSubscriptionConfigApplied } =
    await import(
      pathToFileURL(
        path.join(relay, "dist/agentControl/subscriptionPoolRuntime.js"),
      ).href
    );
  const pool = await syncSubscriptionPool({
    configPath,
    revision: 1,
    members,
    assertRuntimeGuard: async () => {
      const live = await call("relay-channel.subscriptionGuard.status");
      assert.deepEqual(live, status);
      return live;
    },
    waitForConfigApplied: async (text) => {
      try {
        await waitForSubscriptionConfigApplied(configPath, text, {
          request: call,
        });
      } catch (error) {
        const snapshot = await call("config.get");
        console.error("Fixture applied config:", {
          valid: snapshot.valid,
          configRevisionHash: snapshot.configRevisionHash,
          appliedConfigHash: snapshot.appliedConfigHash,
          model: snapshot.config?.agents?.defaults?.model,
        });
        console.error("Fixture Gateway:", logs.slice(-7000));
        throw error;
      }
    },
    refreshRuntimeAuth: () => refreshSubscriptionPoolAuth({ request: call }),
  });
  const configAfterConnect = await fs.readFile(configPath, "utf8");
  const expectedConfig = JSON.parse(configBefore);
  if (strict) expectedConfig.agents.defaults.model.fallbacks = [];
  assert.deepEqual(
    JSON.parse(configAfterConnect),
    expectedConfig,
    "Connect may change only model fallback on strict hosts",
  );
  if (strict) cfg.agents.defaults.model.fallbacks = [];
  assert.deepEqual((await read()).order.openai, [
    "openai:golem-a",
    "openai:golem-b",
  ]);
  const db = path.join(state, "state/openclaw.sqlite");
  const beforeRead = await fs.readFile(db);
  await read();
  assert.deepEqual(await fs.readFile(db), beforeRead);
  // Actual installed hook runner; internal bundled filenames/export aliases are
  // fixture discovery only, never a production plugin dependency.
  const { registerSubscriptionGuard } = await import(
    pathToFileURL(path.join(plugin, "dist/src/subscription-guard.js")).href
  );
  let createHookRunner;
  for (const file of await fs.readdir(path.join(host, "dist"))) {
    if (!/^hooks-.*\.mjs$/.test(file)) continue;
    const source = await fs.readFile(path.join(host, "dist", file), "utf8");
    const alias = source.match(/createHookRunner as ([A-Za-z_$][\w$]*)/);
    if (alias) {
      createHookRunner = (
        await import(pathToFileURL(path.join(host, "dist", file)).href)
      )[alias[1]];
      break;
    }
  }
  assert.equal(
    typeof createHookRunner,
    "function",
    "Official host hook runner unavailable",
  );
  const registry = { typedHooks: [] };
  registerSubscriptionGuard({
    config: cfg,
    runtime: {
      version: hostVersion,
      state: { resolveStateDir: () => state },
      config: { current: () => cfg },
      modelAuth: {
        ensureAuthProfileStore: sdk.ensureAuthProfileStore,
        ensureAuthProfileStoreAsync: sdk.ensureAuthProfileStoreAsync,
      },
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
    (
      await runner.runBeforeAgentRun(
        {},
        { ...ctx, modelProviderId: "anthropic", modelId: "paid" },
      )
    ).decision.outcome,
    "block",
  );
  if (strict)
    assert.equal(
      (await runner.runBeforeAgentRun({}, { ...ctx, modelId: "other" }))
        .decision.outcome,
      "block",
    );
  cfg.agents.defaults.model.fallbacks = ["anthropic/paid"];
  assert.equal(
    (await runner.runBeforeAgentRun({}, ctx)).decision.outcome,
    strict ? "block" : "pass",
  );
  if (!strict) {
    const resolved = await runner.runBeforeModelResolve({}, ctx);
    assert.deepEqual(resolved.fallbacksOverride, []);
    assert.equal(resolved.modelOverride, undefined);
    assert.equal(resolved.providerOverride, undefined);
  }
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
  await refreshSubscriptionPoolAuth({ request: call });
  await fs.writeFile(
    configPath + ".golem-openai-pool.json",
    JSON.stringify({ ...next, phase: "applied" }),
  );
  // This parent process has its own SDK auth snapshot; the live RPC refreshes
  // the Gateway's snapshot, not this probe's cache. Test exhaustion in the real
  // refreshed Gateway below, including a strict zero-new-dispatch assertion.
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
    /OPENAI_SUBSCRIPTIONS|subscription-only|golem-subscription-denied|unavailable|Explicit auth order for openai has no usable profiles\./i,
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
  assert.equal(await fs.readFile(configPath, "utf8"), configAfterConnect);
  console.log(
    JSON.stringify(
      {
        host: hostVersion,
        guard: status,
        actualSdkPoolAB: true,
        actualGatewaySyntheticA429ToB: true,
        readOnlyStorePreserved: true,
        actualHostHookAllow: true,
        injectedOtherModelBlocked: true,
        configuredFallbackBlocked: strict,
        runScopedFallbackSuppressed: !strict,
        exhaustedPoolBlocked: true,
        actualGatewayTurnRefused: true,
        coreAuthOrderRefused: turn.includes(
          "Explicit auth order for openai has no usable profiles.",
        ),
        authoredConfigPreservedExceptExplicitStrictFallbackCleanup: true,
        strictConnectClearedFallbackBeforeAuth: strict,
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
