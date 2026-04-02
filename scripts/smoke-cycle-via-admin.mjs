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
