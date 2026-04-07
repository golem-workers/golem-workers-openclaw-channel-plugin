import { spawnSync } from "node:child_process";
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

function usage() {
  return [
    "Usage:",
    "  npm run bundle:agent -- [options]",
    "",
    "Options:",
    "  --output <path>   Output .tgz path",
    "  --skip-build      Do not run npm run build before bundling",
    "  --help            Show this help",
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

async function pathExists(targetPath) {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    cwd: repoRoot,
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(" ")}`);
  }
}

export async function buildAgentBundle(input = {}) {
  const pluginManifestPath = path.join(repoRoot, "openclaw.plugin.json");
  const pluginManifest = JSON.parse(await readFile(pluginManifestPath, "utf8"));
  const pluginId =
    typeof input.pluginId === "string" && input.pluginId.trim().length > 0
      ? input.pluginId.trim()
      : typeof pluginManifest.id === "string" && pluginManifest.id.trim().length > 0
        ? pluginManifest.id.trim()
        : "relay-channel";

  const outputPath =
    typeof input.outputPath === "string" && input.outputPath.trim().length > 0
      ? path.resolve(repoRoot, input.outputPath)
      : path.join(repoRoot, ".artifacts", pluginId, `${pluginId}-bundle.tgz`);

  if (!input.skipBuild) {
    runCommand("npm", ["run", "build"]);
  }

  const distPath = path.join(repoRoot, "dist");
  if (!(await pathExists(distPath))) {
    throw new Error("Missing dist/. Run npm run build first.");
  }

  const artifactRoot = path.join(repoRoot, ".artifacts", pluginId);
  const stagingRoot = path.join(artifactRoot, "staging");
  const stagingPackageDir = path.join(stagingRoot, pluginId);

  await rm(stagingRoot, { recursive: true, force: true });
  await mkdir(stagingPackageDir, { recursive: true });
  await mkdir(path.dirname(outputPath), { recursive: true });

  for (const fileName of [
    "package.json",
    "package-lock.json",
    "openclaw.plugin.json",
    "README.md",
  ]) {
    await cp(path.join(repoRoot, fileName), path.join(stagingPackageDir, fileName));
  }
  await cp(distPath, path.join(stagingPackageDir, "dist"), { recursive: true });
  await writeFile(
    path.join(stagingPackageDir, "dist", "openclaw.plugin.json"),
    `${JSON.stringify(
      {
        ...pluginManifest,
        entry: "./index.js",
        ...(typeof pluginManifest.setupEntry === "string"
          ? { setupEntry: "./setup-entry.js" }
          : {}),
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  runCommand(
    "npm",
    ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
    { cwd: stagingPackageDir }
  );

  await rm(outputPath, { force: true });
  // OpenClaw rejects link entries inside plugin archives, while npm may emit
  // symlinks in node_modules/.bin on Linux. Pack the dereferenced tree instead.
  runCommand("tar", ["-czhf", outputPath, "-C", stagingRoot, pluginId], {
    env: {
      ...process.env,
      COPYFILE_DISABLE: "1",
    },
  });

  return {
    pluginId,
    outputPath,
    installDirName: pluginId,
  };
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help")) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const result = await buildAgentBundle({
    outputPath: parseStringFlag(argv, "--output"),
    skipBuild: parseBooleanFlag(argv, "--skip-build"),
  });

  process.stdout.write(`${result.outputPath}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
