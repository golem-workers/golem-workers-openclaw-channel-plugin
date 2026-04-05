import { spawnSync } from "node:child_process";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deployAgentBundle } from "./deploy-agent-bundle.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const backendEnvPath = path.resolve(repoRoot, "../golem-workers-backend/.env");
const defaultBackendBaseUrl = "https://dev-api.golemworkers.com";
const defaultTaskTimeoutMs = 25 * 60_000;
const defaultPollIntervalMs = 5_000;

function usage() {
  return [
    "Usage:",
    "  npm run smoke:agent -- [options]",
    "",
    "Options:",
    "  --base-url <url>             Backend base URL",
    "  --token <token>              Admin bearer token",
    "  --provider-account-id <id>   GOLEM provider account id",
    "  --region <name>              Preferred region",
    "  --server-type <name>         Preferred server type",
    "  --image <id>                 Snapshot/image id",
    "  --name <name>                Temporary server name",
    "  --channel-config-file <path> Local relay-channel config JSON",
    "  --mock-relay                Start a mock relay websocket on 127.0.0.1:43129",
    "  --identity-file <path>       Reuse a local SSH key file instead of temp file",
    "  --task-timeout-ms <ms>       Create/wait timeout",
    "  --poll-ms <ms>               Poll interval",
    "  --keep-server                Keep created server after the smoke check",
    "  --skip-build                 Skip npm run build during auto-bundle",
    "  --help                       Show this help",
  ].join("\n");
}

function parseEnvFile(text) {
  const env = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex <= 0) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1);
    env[key] = value;
  }
  return env;
}

function parseStringFlag(argv, name) {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${name}`);
  }
  return value.trim();
}

function parseBooleanFlag(argv, name) {
  return argv.includes(name);
}

function parsePositiveNumber(value, flagName) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${flagName} must be a positive number`);
  }
  return parsed;
}

function normalizeBaseUrl(value) {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new Error("Invalid backend base URL");
  }
  return trimmed;
}

function buildDefaultName(now = new Date()) {
  return `relay-channel-smoke-${now.toISOString().replace(/[:.]/g, "-")}`;
}

function readTaskStatus(payload) {
  const status = payload?.task?.status;
  if (typeof status !== "string" || !status.trim()) {
    throw new Error(`Missing task status in payload: ${JSON.stringify(payload)}`);
  }
  return status.trim();
}

function readTaskId(payload) {
  const taskId = payload?.task?.id;
  if (typeof taskId !== "string" || !taskId.trim()) {
    throw new Error(`Missing task id in payload: ${JSON.stringify(payload)}`);
  }
  return taskId.trim();
}

function readServerId(payload) {
  const serverId = payload?.task?.serverId;
  if (typeof serverId !== "string" || !serverId.trim()) {
    throw new Error(`Missing server id in payload: ${JSON.stringify(payload)}`);
  }
  return serverId.trim();
}

function readMetadataSshHost(payload) {
  const host = payload?.server?.metadata?.sshHost ?? payload?.metadata?.sshHost;
  return typeof host === "string" && host.trim() ? host.trim() : null;
}

function readMetadataSshPort(payload) {
  const port = payload?.server?.metadata?.sshPort ?? payload?.metadata?.sshPort;
  if (typeof port === "number" && Number.isInteger(port) && port > 0) {
    return port;
  }
  if (typeof port === "string" && /^\d+$/.test(port)) {
    return Number(port);
  }
  return null;
}

function readOpenclawConnected(payload) {
  const candidates = [
    payload?.server?.openclawStatus?.connected,
    payload?.openclawStatus?.connected,
    payload?.server?.runtimeInfo?.openclawConnected,
    payload?.runtimeInfo?.openclawConnected,
    payload?.server?.runtime?.openclawConnected,
    payload?.runtime?.openclawConnected,
  ];
  return candidates.find((value) => typeof value === "boolean");
}

function readGatewayOk(payload) {
  const candidates = [
    payload?.server?.runtimeInfo?.gatewayStatus?.ok,
    payload?.runtimeInfo?.gatewayStatus?.ok,
  ];
  return candidates.find((value) => typeof value === "boolean");
}

function readServerStatus(payload) {
  const status = payload?.server?.status ?? payload?.status;
  return typeof status === "string" && status.trim() ? status.trim() : null;
}

async function requestJson({ method, url, token, expectedStatus, body }) {
  const headers = {
    authorization: `Bearer ${token}`,
  };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
  }
  const response = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : null;
  if (response.status !== expectedStatus) {
    throw new Error(`Unexpected HTTP ${response.status} for ${method} ${url}\n${text || "<empty response>"}`);
  }
  return parsed;
}

function buildMockRelaySource({
  pluginInstallDir = "/root/.openclaw/workspace/plugins/relay-channel",
  port = 43129,
}) {
  return `import { createRequire } from "node:module";
const require = createRequire(${JSON.stringify(`${pluginInstallDir}/package.json`)});
const { WebSocketServer } = require("ws");

const host = "127.0.0.1";
const port = ${port};
let actionCounter = 0;

const server = new WebSocketServer({ host, port });
console.log(JSON.stringify({ event: "mock-relay-started", host, port }));

server.on("connection", (ws) => {
  console.log(JSON.stringify({ event: "mock-relay-connection" }));
  ws.on("message", (raw) => {
    const text = raw.toString();
    let frame;
    try {
      frame = JSON.parse(text);
    } catch (error) {
      console.error(JSON.stringify({ event: "mock-relay-invalid-json", text, error: String(error) }));
      return;
    }

    if (frame?.type === "hello") {
      ws.send(JSON.stringify({
        type: "hello",
        protocolVersion: 1,
        role: "local-relay",
        relayInstanceId: "relay-channel-live-mock",
        accountId: frame.accountId,
        transport: {
          provider: "telegram",
          providerVersion: "mock",
        },
        coreCapabilities: {
          messageSend: true,
          inboundMessages: true,
          replyTo: true,
          threadRouting: true,
        },
        optionalCapabilities: {
          typing: true,
        },
        providerCapabilities: {},
        targetCapabilities: {
          dm: {},
          group: { typing: true },
        },
        limits: {
          maxUploadBytes: 1024,
          maxCaptionBytes: 256,
          maxPollOptions: 3,
        },
        dataPlane: {
          uploadBaseUrl: "http://127.0.0.1:43129/uploads",
          downloadBaseUrl: "http://127.0.0.1:43129/downloads",
        },
      }));
      ws.send(JSON.stringify({
        type: "event",
        eventType: "transport.account.ready",
        payload: {
          accountId: frame.accountId,
          state: "healthy",
        },
      }));
      console.log(JSON.stringify({ event: "mock-relay-hello", accountId: frame.accountId }));
      return;
    }

    if (frame?.requestType === "transport.action") {
      actionCounter += 1;
      console.log(JSON.stringify({
        event: "mock-relay-action",
        requestId: frame.requestId,
        actionId: frame.action?.actionId ?? null,
        kind: frame.action?.kind ?? null,
        target: frame.action?.transportTarget ?? null,
        payload: frame.action?.payload ?? null,
      }));
      const conversationId =
        frame.action?.conversation?.handle ??
        frame.action?.transportTarget?.chatId ??
        "mock-conversation";
      const threadId = frame.action?.thread?.handle ?? frame.action?.thread?.threadId ?? null;
      const result = {
        transportMessageId: "mock-message-" + String(actionCounter),
        conversationId,
      };
      if (threadId) {
        result.threadId = threadId;
      }
      ws.send(JSON.stringify({
        type: "event",
        eventType: "transport.action.accepted",
        payload: {
          requestId: frame.requestId,
          actionId: frame.action.actionId,
        },
      }));
      ws.send(JSON.stringify({
        type: "event",
        eventType: "transport.action.completed",
        payload: {
          requestId: frame.requestId,
          actionId: frame.action.actionId,
          result,
        },
      }));
      return;
    }

  });
});

const shutdown = () => {
  server.close(() => process.exit(0));
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
`;
}

async function startMockRelay({
  host,
  sshPort,
  identityFile,
  mockPort = 43129,
  pluginInstallDir = "/root/.openclaw/workspace/plugins/relay-channel",
}) {
  const scriptPath = `/tmp/relay-channel-live-mock-${mockPort}.mjs`;
  const logPath = `/tmp/relay-channel-live-mock-${mockPort}.log`;
  const encodedSource = Buffer.from(
    buildMockRelaySource({ pluginInstallDir, port: mockPort }),
    "utf8"
  ).toString("base64");

  runSshScript({
    host,
    port: sshPort,
    identityFile,
    script: `set -eu
python3 - <<'PY'
from pathlib import Path
import base64
Path(${JSON.stringify(scriptPath)}).write_text(base64.b64decode(${JSON.stringify(encodedSource)}).decode("utf-8"), encoding="utf-8")
PY
pkill -f ${JSON.stringify(scriptPath)} || true
rm -f ${JSON.stringify(logPath)}
nohup node ${JSON.stringify(scriptPath)} > ${JSON.stringify(logPath)} 2>&1 < /dev/null &
echo mock-relay-started`,
  });

  const portReady = runSshScript({
    host,
    port: sshPort,
    identityFile,
    script: `python3 - <<'PY'
import socket
import time

deadline = time.time() + 15
while time.time() < deadline:
    sock = socket.socket()
    sock.settimeout(1)
    try:
        sock.connect(("127.0.0.1", ${mockPort}))
        sock.close()
        print("ready")
        raise SystemExit(0)
    except OSError:
        time.sleep(0.5)
    finally:
        try:
            sock.close()
        except OSError:
            pass
raise SystemExit(1)
PY`,
  });

  if (!portReady.stdout.includes("ready")) {
    const mockLog = runSshScript({
      host,
      port: sshPort,
      identityFile,
      script: `python3 - <<'PY'
from pathlib import Path
path = Path(${JSON.stringify(logPath)})
if path.exists():
    print(path.read_text(encoding='utf-8', errors='replace'))
PY`,
    });
    throw new Error(
      `Mock relay did not bind to 127.0.0.1:${mockPort}.\nMock log:\n${mockLog.stdout || "<empty>"}`
    );
  }

  return { scriptPath, logPath };
}

async function runMockFunctionalProbe({ host, port, identityFile }) {
  const systemdEnv =
    "export XDG_RUNTIME_DIR=/run/user/0 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/0/bus && ";
  const messageText = `relay-channel mock probe ${new Date().toISOString()}`;

  runSshScript({
    host,
    port,
    identityFile,
    script: `${systemdEnv}systemctl --user restart openclaw-gateway.service`,
  });

  let status = { stdout: "", stderr: "" };
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    status = runSshScript({
      host,
      port,
      identityFile,
      script: `${systemdEnv}openclaw channels status --probe`,
    });
    process.stdout.write(`[smoke] mock functional status attempt ${attempt}\n${status.stdout}`);
    if (
      status.stdout.includes("Relay Channel default:") &&
      !status.stdout.includes("disconnected") &&
      !status.stdout.includes("ECONNREFUSED")
    ) {
      break;
    }
  }

  const resolved = runSshScript({
    host,
    port,
    identityFile,
    script: `${systemdEnv}openclaw channels resolve --channel relay-channel "telegram:group:-100"`,
  });
  process.stdout.write(`[smoke] mock functional resolve\n${resolved.stdout}`);

  const mockLogBeforeSend = runSshScript({
    host,
    port,
    identityFile,
    script: `python3 - <<'PY'
from pathlib import Path
path = Path('/tmp/relay-channel-live-mock-43129.log')
if not path.exists():
    raise SystemExit(1)
lines = path.read_text(encoding='utf-8', errors='replace').splitlines()[-80:]
print("\\n".join(lines))
PY`,
  });

  if (!resolved.stdout.includes("telegram:group:-100 -> telegram:group:-100")) {
    throw new Error(`Mock relay resolve probe did not return the expected normalized target.\n${resolved.stdout}`);
  }
  if (status.stdout.includes("disconnected") || status.stdout.includes("ECONNREFUSED")) {
    throw new Error(
      `Relay channel never became healthy against the mock relay.\nStatus:\n${status.stdout}\nMock log:\n${mockLogBeforeSend.stdout}`
    );
  }

  let send;
  try {
    send = runSshScript({
      host,
      port,
      identityFile,
      script: `${systemdEnv}openclaw message send --channel relay-channel --target "telegram:group:-100" --message ${JSON.stringify(messageText)}`,
    });
  } catch (error) {
    throw new Error(
      `Mock relay send probe failed.\nStatus:\n${status.stdout}\nMock log:\n${mockLogBeforeSend.stdout}\n${error instanceof Error ? error.message : String(error)}`
    );
  }

  const mockLog = runSshScript({
    host,
    port,
    identityFile,
    script: `python3 - <<'PY'
from pathlib import Path
path = Path('/tmp/relay-channel-live-mock-43129.log')
if not path.exists():
    raise SystemExit(1)
lines = path.read_text(encoding='utf-8', errors='replace').splitlines()[-80:]
print("\\n".join(lines))
PY`,
  });

  process.stdout.write(`[smoke] mock functional send\n${send.stdout}`);
  process.stdout.write(`[smoke] mock relay log tail\n${mockLog.stdout}\n`);
  if (!mockLog.stdout.includes('"event":"mock-relay-action"')) {
    throw new Error(`Mock relay did not observe transport.action.\n${mockLog.stdout}`);
  }
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: options.input === undefined ? "inherit" : ["pipe", "inherit", "inherit"],
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(" ")}`);
  }
}

function runCapturedCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: ["pipe", "pipe", "pipe"],
    encoding: "utf8",
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(
      `Command failed: ${command} ${args.join(" ")}\nstdout:\n${result.stdout || "<empty>"}\nstderr:\n${result.stderr || "<empty>"}`
    );
  }
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function buildSshArgs({ identityFile, port }) {
  const args = [];
  if (identityFile) {
    args.push("-i", identityFile);
  }
  args.push("-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null");
  args.push("-p", String(port));
  return args;
}

function runSshScript({ host, port, user = "root", identityFile, script }) {
  return runCapturedCommand(
    "ssh",
    [...buildSshArgs({ identityFile, port }), `${user}@${host}`, "bash -s"],
    { input: script }
  );
}

async function waitForTaskTerminal({ baseUrl, token, taskId, timeoutMs, pollMs }) {
  const startedAt = Date.now();
  let lastPayload = null;
  while (Date.now() - startedAt < timeoutMs) {
    const payload = await requestJson({
      method: "GET",
      url: `${baseUrl}/api/v1/servers/tasks/${taskId}`,
      token,
      expectedStatus: 200,
    });
    lastPayload = payload;
    const status = readTaskStatus(payload);
    process.stdout.write(`[smoke] task ${taskId}: ${status}\n`);
    if (status !== "PENDING" && status !== "RUNNING") {
      if (status !== "SUCCESS") {
        throw new Error(`Server creation failed: ${JSON.stringify(payload)}`);
      }
      return payload;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error(`Timed out waiting for create task ${taskId}: ${JSON.stringify(lastPayload)}`);
}

async function waitForServerReady({ baseUrl, token, serverId, timeoutMs, pollMs }) {
  const startedAt = Date.now();
  let lastPayload = null;
  while (Date.now() - startedAt < timeoutMs) {
    const payload = await requestJson({
      method: "GET",
      url: `${baseUrl}/api/v1/servers/${serverId}`,
      token,
      expectedStatus: 200,
    });
    lastPayload = payload;
    const status = readServerStatus(payload);
    const openclawConnected = readOpenclawConnected(payload);
    const gatewayOk = readGatewayOk(payload);
    process.stdout.write(
      `[smoke] server ${serverId}: status=${status ?? "unknown"} openclawConnected=${String(openclawConnected)} gatewayOk=${String(gatewayOk)}\n`
    );
    if (status === "RUNNING" && (openclawConnected === true || gatewayOk === true)) {
      return payload;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error(`Timed out waiting for server readiness ${serverId}: ${JSON.stringify(lastPayload)}`);
}

async function writeTempPrivateKey(privateKey) {
  const dir = path.join(repoRoot, ".artifacts", "smoke");
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `agent-key-${Date.now()}.pem`);
  await writeFile(filePath, privateKey, { mode: 0o600 });
  await chmod(filePath, 0o600);
  return filePath;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help")) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const env = parseEnvFile(await readFile(backendEnvPath, "utf8"));
  const baseUrl = normalizeBaseUrl(
    parseStringFlag(argv, "--base-url") ?? env.CURRENT_URL ?? defaultBackendBaseUrl
  );
  const token = parseStringFlag(argv, "--token") ?? env.ADMIN_BEARER_AUTH_TOKEN ?? "";
  if (!token) {
    throw new Error("Missing admin bearer token");
  }
  const providerAccountId =
    parseStringFlag(argv, "--provider-account-id") ?? env.E2E_PROVIDER_ACCOUNT_ID ?? "";
  if (!providerAccountId) {
    throw new Error("Missing provider account id");
  }

  const taskTimeoutMs = parseStringFlag(argv, "--task-timeout-ms")
    ? parsePositiveNumber(parseStringFlag(argv, "--task-timeout-ms"), "--task-timeout-ms")
    : defaultTaskTimeoutMs;
  const pollMs = parseStringFlag(argv, "--poll-ms")
    ? parsePositiveNumber(parseStringFlag(argv, "--poll-ms"), "--poll-ms")
    : defaultPollIntervalMs;
  const keepServer = parseBooleanFlag(argv, "--keep-server");
  const mockRelay = parseBooleanFlag(argv, "--mock-relay");
  const name = parseStringFlag(argv, "--name") ?? buildDefaultName();
  const region = parseStringFlag(argv, "--region") ?? env.E2E_PROVIDER_REGION;
  const serverType = parseStringFlag(argv, "--server-type") ?? env.E2E_PROVIDER_SERVER_TYPE;
  const image = parseStringFlag(argv, "--image") ?? env.E2E_PROVIDER_SNAPSHOT_ID;
  const channelConfigPath = parseStringFlag(argv, "--channel-config-file");

  let createdServerId = null;
  let tempKeyPath = null;

  try {
    process.stdout.write("[smoke] creating temporary server via admin API\n");
    const createPayload = {
      provider: "GOLEM_PROVIDER",
      paymentProvider: "STRIPE",
      providerAccountId,
      name,
      ...(region ? { region } : {}),
      ...(serverType ? { serverType } : {}),
      ...(image ? { image } : {}),
    };
    const createResponse = await requestJson({
      method: "POST",
      url: `${baseUrl}/api/v1/servers`,
      token,
      expectedStatus: 202,
      body: createPayload,
    });
    const taskId = readTaskId(createResponse);
    const taskPayload = await waitForTaskTerminal({
      baseUrl,
      token,
      taskId,
      timeoutMs: taskTimeoutMs,
      pollMs,
    });
    createdServerId = readServerId(taskPayload);
    process.stdout.write(`[smoke] created server ${createdServerId}\n`);

    const readyPayload = await waitForServerReady({
      baseUrl,
      token,
      serverId: createdServerId,
      timeoutMs: taskTimeoutMs,
      pollMs,
    });
    const sshHost = readMetadataSshHost(readyPayload);
    const sshPort = readMetadataSshPort(readyPayload);
    if (!sshHost || !sshPort) {
      throw new Error(`Missing ssh host/port in server details: ${JSON.stringify(readyPayload)}`);
    }

    const accessKeyResponse = await requestJson({
      method: "GET",
      url: `${baseUrl}/api/v1/servers/${createdServerId}/access-key`,
      token,
      expectedStatus: 200,
    });
    const privateKey = typeof accessKeyResponse?.privateKey === "string" ? accessKeyResponse.privateKey : "";
    if (!privateKey) {
      throw new Error("Access key response missing privateKey");
    }

    tempKeyPath = parseStringFlag(argv, "--identity-file") ?? (await writeTempPrivateKey(privateKey));
    process.stdout.write(`[smoke] deploying relay-channel to ${sshHost}:${sshPort}\n`);
    await deployAgentBundle({
      host: sshHost,
      port: sshPort,
      user: "root",
      identityFile: tempKeyPath,
      pluginId: "relay-channel",
      ...(channelConfigPath ? { channelConfigPath } : {}),
      skipBuild: parseBooleanFlag(argv, "--skip-build"),
      restartGateway: true,
      keepRemoteBundle: false,
    });

    process.stdout.write("[smoke] verifying runtime through backend diagnostic script\n");
    runCommand("node", [
      "../golem-workers-backend/src/scripts/check-relay-runtime-via-admin.ts",
      "--base-url",
      baseUrl,
      "--token",
      token,
      "--server-id",
      createdServerId,
      "--expect-plugin-id",
      "relay-channel",
    ]);

    if (mockRelay) {
      process.stdout.write("[smoke] starting mock relay on 127.0.0.1:43129\n");
      await startMockRelay({
        host: sshHost,
        sshPort,
        identityFile: tempKeyPath,
        mockPort: 43129,
      });
      process.stdout.write("[smoke] running functional probe through mock relay\n");
      await runMockFunctionalProbe({
        host: sshHost,
        port: sshPort,
        identityFile: tempKeyPath,
      });
    }

    process.stdout.write(`[smoke] success for server ${createdServerId}\n`);
  } finally {
    if (tempKeyPath && !parseStringFlag(argv, "--identity-file")) {
      await rm(tempKeyPath, { force: true });
    }
    if (createdServerId && !keepServer) {
      process.stdout.write(`[smoke] deleting temporary server ${createdServerId}\n`);
      try {
        await requestJson({
          method: "DELETE",
          url: `${baseUrl}/api/v1/servers/${createdServerId}`,
          token,
          expectedStatus: 200,
        });
        process.stdout.write(`[smoke] deleted temporary server ${createdServerId}\n`);
      } catch (error) {
        process.stderr.write(`[smoke] failed to delete temporary server ${createdServerId}: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
