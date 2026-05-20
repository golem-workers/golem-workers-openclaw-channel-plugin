import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile as writeTempFile } from "node:fs/promises";
import { access, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildAgentBundle } from "./build-agent-bundle.mjs";
import { EXPECTED_NPM_PACKAGE_NAME, loadNpmPublishContract } from "./lib/npm-publish-contract.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

function usage() {
  return [
    "Usage:",
    "  npm run publish:npm-release -- [options]",
    "",
    "Options:",
    "  --version <semver>   Target release version (updates package.json without git)",
    "  --dry-run            Run npm publish --dry-run instead of publishing",
    "  --publish            Publish to npm (requires NPM_TOKEN when not dry-run)",
    "  --prepare-only       Build, validate, and bundle only (no npm publish)",
    "  --skip-bundle        Skip relay-channel-bundle.tgz build",
    "  --openclaw-host-version <ver>",
    "                       Sets openclaw.build.openclawVersion before publish",
    "  --help               Show this help",
  ].join("\n");
}

function parseArgs(argv) {
  const args = {
    version: undefined,
    dryRun: false,
    publish: false,
    prepareOnly: false,
    skipBundle: false,
    openclawHostVersion: process.env.RELAY_CHANNEL_PLUGIN_OPENCLAW_HOST_VERSION?.trim() || "2026.5.18",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help") {
      args.help = true;
      continue;
    }
    if (arg === "--dry-run") {
      args.dryRun = true;
      continue;
    }
    if (arg === "--publish") {
      args.publish = true;
      continue;
    }
    if (arg === "--prepare-only") {
      args.prepareOnly = true;
      continue;
    }
    if (arg === "--skip-bundle") {
      args.skipBundle = true;
      continue;
    }
    if (arg === "--version") {
      args.version = argv[index + 1]?.trim();
      index += 1;
      continue;
    }
    if (arg === "--openclaw-host-version") {
      args.openclawHostVersion = argv[index + 1]?.trim();
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
}

function runCommand(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
    env: {
      ...process.env,
      ...options.env,
    },
  });

  if (result.status !== 0) {
    const stderr = result.stderr?.trim();
    const stdout = result.stdout?.trim();
    const detail = stderr || stdout || `exit ${result.status ?? "unknown"}`;
    throw new Error(`${command} ${commandArgs.join(" ")} failed: ${detail}`);
  }

  return result;
}

async function updatePackageJson(input) {
  const packageJsonPath = path.join(repoRoot, "package.json");
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));

  if (input.version) {
    packageJson.version = input.version;
  }

  packageJson.openclaw ??= {};
  packageJson.openclaw.build ??= {};
  packageJson.openclaw.build.openclawVersion = input.openclawHostVersion;

  await writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
  return packageJson;
}

let npmAuthTempDir;

async function configureNpmAuthFromToken() {
  const token = process.env.NPM_TOKEN?.trim();
  if (!token) {
    return;
  }
  if (process.env.NPM_CONFIG_USERCONFIG?.trim()) {
    return;
  }

  npmAuthTempDir = await mkdtemp(path.join(tmpdir(), "golemworkers-npm-auth-"));
  const npmrcPath = path.join(npmAuthTempDir, ".npmrc");
  await writeTempFile(npmrcPath, `//registry.npmjs.org/:_authToken=${token}\n`, "utf8");
  process.env.NPM_CONFIG_USERCONFIG = npmrcPath;
}

async function cleanupNpmAuthTempDir() {
  if (!npmAuthTempDir) {
    return;
  }
  await rm(npmAuthTempDir, { recursive: true, force: true });
  npmAuthTempDir = undefined;
}

async function assertNpmAuthRequired(publish) {
  if (!publish) {
    return;
  }
  await configureNpmAuthFromToken();
  const whoami = spawnSync("npm", ["whoami"], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: "pipe",
    env: process.env,
  });
  if (whoami.status === 0 && whoami.stdout.trim()) {
    return;
  }
  throw new Error("npm publish requires NPM_TOKEN or an authenticated npm whoami session");
}

async function restorePackageJson(snapshot) {
  if (!snapshot) {
    return;
  }
  const packageJsonPath = path.join(repoRoot, "package.json");
  await writeFile(packageJsonPath, snapshot, "utf8");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  if (!args.prepareOnly && !args.dryRun && !args.publish) {
    throw new Error("Refusing to run without --prepare-only, --publish, or --dry-run");
  }

  const packageJsonPath = path.join(repoRoot, "package.json");
  const packageJsonSnapshot = await readFile(packageJsonPath, "utf8");
  const shouldRestorePackageJson = args.dryRun;

  try {
  await configureNpmAuthFromToken();
  runCommand("npm", ["run", "build"]);
  const packageJson = await updatePackageJson(args);

  const contract = await loadNpmPublishContract(repoRoot);
  if (contract.issues.length > 0) {
    throw new Error(contract.issues.join("\n"));
  }

  for (const filePath of contract.requiredPublishFiles) {
    await access(filePath);
  }

  let bundlePath;
  if (!args.skipBundle) {
    const bundle = await buildAgentBundle({ skipBuild: true });
    bundlePath = bundle.outputPath;
    process.stdout.write(`bundle: ${bundlePath}\n`);
  }

  runCommand("npm", ["run", "validate:npm-publish"]);

  if (args.prepareOnly) {
    process.stdout.write(
      `prepared ${EXPECTED_NPM_PACKAGE_NAME}@${packageJson.version} for release\n`
    );
    if (bundlePath) {
      process.stdout.write(`bundle artifact: ${bundlePath}\n`);
    }
    return;
  }

  await assertNpmAuthRequired(args.publish && !args.dryRun);

  const publishArgs = args.dryRun ? ["publish", "--dry-run", "--access", "public"] : ["publish", "--access", "public"];
  runCommand("npm", publishArgs, {
    env: {
      NPM_CONFIG_ACCESS: "public",
    },
  });

  const mode = args.dryRun ? "dry-run" : "published";
  process.stdout.write(
    `${mode} npm package ${EXPECTED_NPM_PACKAGE_NAME}@${packageJson.version}\n`
  );

  if (bundlePath) {
    process.stdout.write(`bundle artifact: ${bundlePath}\n`);
  }
  } finally {
    if (shouldRestorePackageJson) {
      await restorePackageJson(packageJsonSnapshot);
    }
    await cleanupNpmAuthTempDir();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
