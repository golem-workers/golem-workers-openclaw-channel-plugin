import { readFile } from "node:fs/promises";
import path from "node:path";

const REQUIRED_OPENCLAW_FIELDS = ["openclaw.compat.pluginApi", "openclaw.build.openclawVersion"];

const REQUIRED_PACKAGE_FIELDS = ["name", "version", "description", "repository.url"];

const REQUIRED_MANIFEST_FIELDS = ["id", "kind", "channels", "channelConfigs"];

const REQUIRED_PUBLISH_FILES = ["dist/index.js", "dist/setup-entry.js", "openclaw.plugin.json"];

export const EXPECTED_NPM_PACKAGE_NAME = "@golemworkers/relay-channel";

export function parseJsonObject(raw, label) {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`${label} must be a JSON object`);
    }
    return parsed;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} is invalid JSON: ${message}`);
  }
}

function readPath(record, dottedPath) {
  const parts = dottedPath.split(".");
  let current = record;
  for (const part of parts) {
    if (!current || typeof current !== "object" || !(part in current)) {
      return undefined;
    }
    current = current[part];
  }
  return current;
}

function normalizeString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function collectNpmPublishContractIssues(input) {
  const issues = [];
  const packageJson = input.packageJson;
  const manifest = input.manifest;

  for (const fieldPath of REQUIRED_PACKAGE_FIELDS) {
    if (!normalizeString(readPath(packageJson, fieldPath))) {
      issues.push(`package.json missing ${fieldPath}`);
    }
  }

  if (packageJson.private === true) {
    issues.push("package.json must not be private for npm publish");
  }

  if (packageJson.name !== EXPECTED_NPM_PACKAGE_NAME) {
    issues.push(`package.json name must be ${EXPECTED_NPM_PACKAGE_NAME}`);
  }

  const npmSpec = normalizeString(readPath(packageJson, "openclaw.install.npmSpec"));
  if (npmSpec !== EXPECTED_NPM_PACKAGE_NAME) {
    issues.push(`openclaw.install.npmSpec must be ${EXPECTED_NPM_PACKAGE_NAME}`);
  }

  for (const fieldPath of REQUIRED_OPENCLAW_FIELDS) {
    if (!normalizeString(readPath(packageJson, fieldPath))) {
      issues.push(`package.json missing ${fieldPath}`);
    }
  }

  if (readPath(packageJson, "openclaw.release.publishToNpm") !== true) {
    issues.push("openclaw.release.publishToNpm must be true");
  }

  for (const fieldPath of REQUIRED_MANIFEST_FIELDS) {
    const value = readPath(manifest, fieldPath);
    if (fieldPath === "channels") {
      if (!Array.isArray(value) || !value.includes("relay-channel")) {
        issues.push("openclaw.plugin.json must declare relay-channel in channels");
      }
      continue;
    }
    if (fieldPath === "channelConfigs") {
      const relayConfig = value?.["relay-channel"];
      if (!relayConfig || typeof relayConfig !== "object") {
        issues.push("openclaw.plugin.json missing channelConfigs.relay-channel");
      }
      continue;
    }
    if (!normalizeString(value) && fieldPath !== "kind") {
      issues.push(`openclaw.plugin.json missing ${fieldPath}`);
    }
  }

  if (manifest.id !== "relay-channel") {
    issues.push('openclaw.plugin.json id must be "relay-channel"');
  }

  return issues;
}

export async function loadNpmPublishContract(repoRoot) {
  const packageJsonPath = path.join(repoRoot, "package.json");
  const manifestPath = path.join(repoRoot, "openclaw.plugin.json");
  const packageJson = parseJsonObject(await readFile(packageJsonPath, "utf8"), packageJsonPath);
  const manifest = parseJsonObject(await readFile(manifestPath, "utf8"), manifestPath);
  return {
    packageJson,
    manifest,
    issues: collectNpmPublishContractIssues({ packageJson, manifest }),
    requiredPublishFiles: REQUIRED_PUBLISH_FILES.map((relativePath) =>
      path.join(repoRoot, relativePath)
    ),
  };
}
