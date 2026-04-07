import { spawnSync } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildAgentBundle } from "./build-agent-bundle.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

function usage() {
  return [
    "Usage:",
    "  npm run deploy:agent -- --host <host> [options]",
    "",
    "Options:",
    "  --host <host>                SSH host",
    "  --port <port>                SSH port (default: 22)",
    "  --user <user>                SSH user (default: root)",
    "  --identity-file <path>       SSH private key file",
    "  --bundle <path>              Existing local .tgz bundle; if omitted, one is built",
    "  --plugin-id <id>             Plugin id override (default from openclaw.plugin.json)",
    "  --install-dir <path>         Deprecated and unsupported; OpenClaw-managed install path is always used",
    "  --remote-temp-dir <path>     Remote temp dir (default: /tmp)",
    "  --channel-config-file <path> Local JSON file to inject into channels.<plugin-id>",
    "  --skip-build                 Skip npm run build during auto-bundle",
    "  --no-restart                 Do not restart openclaw-gateway.service after install",
    "  --keep-remote-bundle         Keep uploaded .tgz on the agent",
    "  --help                       Show this help",
  ].join("\n");
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

function parsePort(argv) {
  const raw = parseStringFlag(argv, "--port");
  if (!raw) return 22;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("--port must be a positive integer");
  }
  return parsed;
}

function shQuote(value) {
  return `'${String(value).split("'").join("'\"'\"'")}'`;
}

function runCommand(command, args, options = {}) {
  const stdio = options.input === undefined ? "inherit" : ["pipe", "inherit", "inherit"];
  const result = spawnSync(command, args, {
    stdio,
    cwd: repoRoot,
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(" ")}`);
  }
}

function buildSshArgs(input) {
  const sshArgs = [];
  const scpArgs = [];
  if (input.identityFile) {
    sshArgs.push("-i", input.identityFile);
    scpArgs.push("-i", input.identityFile);
  }
  sshArgs.push("-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null");
  scpArgs.push("-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null");
  sshArgs.push("-p", String(input.port));
  scpArgs.push("-P", String(input.port));
  return { sshArgs, scpArgs };
}

function buildRemoteInstallScript(input) {
  return [
    "set -eu",
    `PLUGIN_ID=${shQuote(input.pluginId)}`,
    `REMOTE_BUNDLE=${shQuote(input.remoteBundlePath)}`,
    `CHANNEL_CONFIG_B64=${shQuote(input.channelConfigB64 ?? "")}`,
    `KEEP_REMOTE_BUNDLE=${shQuote(input.keepRemoteBundle ? "1" : "0")}`,
    `RESTART_GATEWAY=${shQuote(input.restartGateway ? "1" : "0")}`,
    'CHANNEL_CONFIG_JSON=""',
    'if [ -n "$CHANNEL_CONFIG_B64" ]; then',
    '  CHANNEL_CONFIG_JSON="$(printf "%s" "$CHANNEL_CONFIG_B64" | base64 -d)"',
    'fi',
    'openclaw plugins uninstall "$PLUGIN_ID" --force >/dev/null 2>&1 || true',
    'openclaw plugins install "$REMOTE_BUNDLE"',
    'if [ -n "$CHANNEL_CONFIG_JSON" ]; then',
    '  openclaw config set "channels.$PLUGIN_ID" "$CHANNEL_CONFIG_JSON" --strict-json',
    'fi',
    'openclaw plugins enable "$PLUGIN_ID"',
    'node - "$PLUGIN_ID" "$CHANNEL_CONFIG_JSON" <<\'NODE\'',
    "const fs = require('fs');",
    "const os = require('os');",
    "const path = require('path');",
    "const pluginId = process.argv[2];",
    "const channelConfigJson = process.argv[3] || '';",
    "const configPath = path.join(os.homedir(), '.openclaw', 'openclaw.json');",
    "const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));",
    "const installRecord = cfg?.plugins?.installs?.[pluginId];",
    "if (!installRecord || typeof installRecord !== 'object' || Array.isArray(installRecord)) {",
    "  throw new Error(`Missing install record for ${pluginId}`);",
    "}",
    "if (typeof installRecord.installPath !== 'string' || installRecord.installPath.trim().length === 0) {",
    "  throw new Error(`Missing install path for ${pluginId}`);",
    "}",
    "const installDir = fs.realpathSync(installRecord.installPath);",
    "const channelConfig = channelConfigJson ? JSON.parse(channelConfigJson) : null;",
    "if (channelConfig) {",
    "  const configuredChannel = cfg?.channels?.[pluginId];",
    "  if (JSON.stringify(configuredChannel) !== JSON.stringify(channelConfig)) {",
    "    throw new Error(`Configured channel payload mismatch for ${pluginId}`);",
    "  }",
    "}",
    "console.log(JSON.stringify({ pluginId, installDir, configPath, hasChannelConfig: Boolean(channelConfig) }));",
    "NODE",
    'if [ "$RESTART_GATEWAY" = "1" ]; then',
    '  export HOME=/root XDG_RUNTIME_DIR=/run/user/0 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/0/bus',
    '  systemctl --user daemon-reload',
    '  systemctl --user restart openclaw-gateway.service',
    '  sleep 5',
    '  OPENCLAW_GATEWAY_ACTIVE_STATE="$(systemctl --user show openclaw-gateway.service -p ActiveState --value 2>/dev/null || true)"',
    '  OPENCLAW_GATEWAY_SUB_STATE="$(systemctl --user show openclaw-gateway.service -p SubState --value 2>/dev/null || true)"',
    '  if [ "$OPENCLAW_GATEWAY_ACTIVE_STATE" != "active" ] || [ "$OPENCLAW_GATEWAY_SUB_STATE" != "running" ]; then',
    '    echo "OpenClaw gateway failed to reach active/running after plugin install" >&2',
    '    journalctl --user -u openclaw-gateway.service -n 120 --no-pager || true',
    "    exit 1",
    "  fi",
    "fi",
    'node - "$PLUGIN_ID" <<\'NODE\'',
    "const fs = require('fs');",
    "const os = require('os');",
    "const path = require('path');",
    "const pluginId = process.argv[2];",
    "const configPath = path.join(os.homedir(), '.openclaw', 'openclaw.json');",
    "const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));",
    "const plugins = cfg.plugins && typeof cfg.plugins === 'object' && !Array.isArray(cfg.plugins) ? cfg.plugins : {};",
    "const installRecord = plugins.installs && typeof plugins.installs === 'object' && !Array.isArray(plugins.installs) ? plugins.installs[pluginId] : null;",
    "if (!installRecord || typeof installRecord.installPath !== 'string') throw new Error(`Missing install record for ${pluginId}`);",
    "const installDir = fs.realpathSync(installRecord.installPath);",
    "const summary = {",
    "  pluginId,",
    "  installDir,",
    "  pluginManifestExists: fs.existsSync(path.join(installDir, 'openclaw.plugin.json')),",
    "  distExists: fs.existsSync(path.join(installDir, 'dist', 'index.js')),",
    "  nodeModulesExists: fs.existsSync(path.join(installDir, 'node_modules')),",
    "  enabled: plugins.entries && typeof plugins.entries === 'object' && !Array.isArray(plugins.entries) ? plugins.entries[pluginId]?.enabled === true : false,",
    "  installSource: installRecord.source ?? null,",
    "  channelKeys: cfg.channels && typeof cfg.channels === 'object' && !Array.isArray(cfg.channels) ? Object.keys(cfg.channels).sort() : [],",
    "};",
    "console.log(JSON.stringify(summary, null, 2));",
    "NODE",
    'if [ "$KEEP_REMOTE_BUNDLE" != "1" ]; then',
    '  rm -f "$REMOTE_BUNDLE"',
    "fi",
  ].join("\n");
}

export async function deployAgentBundle(input) {
  if (!input.host) {
    throw new Error("--host is required");
  }

  if (input.installDir) {
    throw new Error("--install-dir is no longer supported; OpenClaw manages plugin install paths");
  }

  const pluginId = input.pluginId ?? "relay-channel";
  const remoteTempDir = input.remoteTempDir ?? "/tmp";
  const remoteBundlePath = `${remoteTempDir}/${pluginId}-${Date.now()}.tgz`;

  let bundlePath = input.bundlePath;
  if (!bundlePath) {
    await mkdir(path.join(repoRoot, ".artifacts", pluginId), { recursive: true });
    const bundle = await buildAgentBundle({
      pluginId,
      outputPath: path.join(".artifacts", pluginId, `${pluginId}-bundle.tgz`),
      skipBuild: input.skipBuild,
    });
    bundlePath = bundle.outputPath;
  } else {
    bundlePath = path.resolve(repoRoot, bundlePath);
  }

  const channelConfigB64 = input.channelConfigPath
    ? Buffer.from(await readFile(path.resolve(repoRoot, input.channelConfigPath), "utf8"), "utf8").toString("base64")
    : "";

  const { sshArgs, scpArgs } = buildSshArgs(input);
  const remote = `${input.user}@${input.host}`;

  runCommand("scp", [...scpArgs, bundlePath, `${remote}:${remoteBundlePath}`]);
  runCommand(
    "ssh",
    [...sshArgs, remote, "bash -s"],
    {
      input: buildRemoteInstallScript({
        pluginId,
        remoteBundlePath,
        channelConfigB64,
        keepRemoteBundle: input.keepRemoteBundle,
        restartGateway: input.restartGateway,
      }),
    }
  );

  return {
    pluginId,
    bundlePath,
    installDir: null,
    remoteBundlePath,
  };
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help")) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const host = parseStringFlag(argv, "--host");
  const user = parseStringFlag(argv, "--user") ?? "root";
  const identityFile = parseStringFlag(argv, "--identity-file");
  const pluginId = parseStringFlag(argv, "--plugin-id") ?? "relay-channel";

  await deployAgentBundle({
    host,
    port: parsePort(argv),
    user,
    identityFile,
    pluginId,
    bundlePath: parseStringFlag(argv, "--bundle"),
    installDir: parseStringFlag(argv, "--install-dir"),
    remoteTempDir: parseStringFlag(argv, "--remote-temp-dir"),
    channelConfigPath: parseStringFlag(argv, "--channel-config-file"),
    skipBuild: parseBooleanFlag(argv, "--skip-build"),
    restartGateway: !parseBooleanFlag(argv, "--no-restart"),
    keepRemoteBundle: parseBooleanFlag(argv, "--keep-remote-bundle"),
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
