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
    "  --install-dir <path>         Remote install dir (default: ~/.openclaw/workspace/plugins/<id>)",
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
    `INSTALL_DIR=${shQuote(input.installDir)}`,
    `REMOTE_BUNDLE=${shQuote(input.remoteBundlePath)}`,
    `REMOTE_TEMP_DIR=${shQuote(input.remoteTempDir)}`,
    `CHANNEL_CONFIG_B64=${shQuote(input.channelConfigB64 ?? "")}`,
    `KEEP_REMOTE_BUNDLE=${shQuote(input.keepRemoteBundle ? "1" : "0")}`,
    `RESTART_GATEWAY=${shQuote(input.restartGateway ? "1" : "0")}`,
    'INSTALL_PARENT="$(dirname "$INSTALL_DIR")"',
    'STAGE_DIR="$REMOTE_TEMP_DIR/${PLUGIN_ID}-stage-$$"',
    'rm -rf "$STAGE_DIR"',
    'mkdir -p "$INSTALL_PARENT" "$STAGE_DIR"',
    'tar -xzf "$REMOTE_BUNDLE" -C "$STAGE_DIR"',
    'EXTRACTED_DIR="$STAGE_DIR/$PLUGIN_ID"',
    'if [ ! -d "$EXTRACTED_DIR" ]; then',
    '  echo "Expected extracted plugin dir $EXTRACTED_DIR" >&2',
    "  exit 1",
    "fi",
    'rm -rf "$INSTALL_DIR"',
    'mv "$EXTRACTED_DIR" "$INSTALL_DIR"',
    'chown -R root:root "$INSTALL_DIR"',
    'node - "$PLUGIN_ID" "$INSTALL_DIR" "$CHANNEL_CONFIG_B64" <<\'NODE\'',
    "const fs = require('fs');",
    "const os = require('os');",
    "const path = require('path');",
    "const pluginId = process.argv[2];",
    "const installDir = process.argv[3];",
    "const channelConfigB64 = process.argv[4] || '';",
    "const configPath = path.join(os.homedir(), '.openclaw', 'openclaw.json');",
    "const channelConfig = channelConfigB64 ? JSON.parse(Buffer.from(channelConfigB64, 'base64').toString('utf8')) : null;",
    "const ensureRecord = (parent, key) => {",
    "  const value = parent[key];",
    "  if (value && typeof value === 'object' && !Array.isArray(value)) return value;",
    "  const next = {};",
    "  parent[key] = next;",
    "  return next;",
    "};",
    "const normalizeStringArray = (value) => Array.isArray(value) ? value.filter((item) => typeof item === 'string').map((item) => item.trim()).filter(Boolean) : [];",
    "let cfg = {};",
    "try {",
    "  const raw = fs.readFileSync(configPath, 'utf8');",
    "  const parsed = JSON.parse(raw);",
    "  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) cfg = parsed;",
    "} catch (error) {",
    "  if (!error || typeof error !== 'object' || error.code !== 'ENOENT') throw error;",
    "}",
    "const plugins = ensureRecord(cfg, 'plugins');",
    "plugins.enabled = true;",
    "const load = ensureRecord(plugins, 'load');",
    "const paths = normalizeStringArray(load.paths);",
    "if (!paths.includes(installDir)) paths.push(installDir);",
    "load.paths = paths;",
    "const allow = normalizeStringArray(plugins.allow);",
    "if (!allow.includes(pluginId)) allow.push(pluginId);",
    "plugins.allow = allow;",
    "const deny = normalizeStringArray(plugins.deny).filter((value) => value !== pluginId);",
    "if (deny.length > 0) plugins.deny = deny; else delete plugins.deny;",
    "const entries = ensureRecord(plugins, 'entries');",
    "const pluginEntry = ensureRecord(entries, pluginId);",
    "pluginEntry.enabled = true;",
    "if (channelConfig) {",
    "  pluginEntry.config = channelConfig;",
    "  const channels = ensureRecord(cfg, 'channels');",
    "  channels[pluginId] = channelConfig;",
    "}",
    "fs.mkdirSync(path.dirname(configPath), { recursive: true });",
    "const tempPath = `${configPath}.tmp-${process.pid}`;",
    "fs.writeFileSync(tempPath, `${JSON.stringify(cfg, null, 2)}\\n`, 'utf8');",
    "fs.renameSync(tempPath, configPath);",
    "console.log(JSON.stringify({ pluginId, installDir, configPath, loadPaths: load.paths, allow: plugins.allow, hasChannelConfig: Boolean(channelConfig) }));",
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
    'node - "$PLUGIN_ID" "$INSTALL_DIR" <<\'NODE\'',
    "const fs = require('fs');",
    "const os = require('os');",
    "const path = require('path');",
    "const pluginId = process.argv[2];",
    "const installDir = process.argv[3];",
    "const configPath = path.join(os.homedir(), '.openclaw', 'openclaw.json');",
    "const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));",
    "const plugins = cfg.plugins && typeof cfg.plugins === 'object' && !Array.isArray(cfg.plugins) ? cfg.plugins : {};",
    "const load = plugins.load && typeof plugins.load === 'object' && !Array.isArray(plugins.load) ? plugins.load : {};",
    "const summary = {",
    "  pluginId,",
    "  installDir,",
    "  pluginManifestExists: fs.existsSync(path.join(installDir, 'openclaw.plugin.json')),",
    "  distPluginManifestExists: fs.existsSync(path.join(installDir, 'dist', 'openclaw.plugin.json')),",
    "  distExists: fs.existsSync(path.join(installDir, 'dist', 'index.js')),",
    "  nodeModulesExists: fs.existsSync(path.join(installDir, 'node_modules')),",
    "  loadPaths: Array.isArray(load.paths) ? load.paths : [],",
    "  allow: Array.isArray(plugins.allow) ? plugins.allow : [],",
    "  deny: Array.isArray(plugins.deny) ? plugins.deny : [],",
    "  channelKeys: cfg.channels && typeof cfg.channels === 'object' && !Array.isArray(cfg.channels) ? Object.keys(cfg.channels).sort() : [],",
    "};",
    "console.log(JSON.stringify(summary, null, 2));",
    "NODE",
    'if [ "$KEEP_REMOTE_BUNDLE" != "1" ]; then',
    '  rm -f "$REMOTE_BUNDLE"',
    "fi",
    'rm -rf "$STAGE_DIR"',
  ].join("\n");
}

export async function deployAgentBundle(input) {
  if (!input.host) {
    throw new Error("--host is required");
  }

  const pluginId = input.pluginId ?? "relay-channel";
  const installDir =
    input.installDir ?? `/root/.openclaw/workspace/plugins/${pluginId}`;
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
        installDir,
        remoteBundlePath,
        remoteTempDir,
        channelConfigB64,
        keepRemoteBundle: input.keepRemoteBundle,
        restartGateway: input.restartGateway,
      }),
    }
  );

  return {
    pluginId,
    bundlePath,
    installDir,
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
