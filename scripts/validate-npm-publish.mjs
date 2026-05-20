import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadNpmPublishContract } from "./lib/npm-publish-contract.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

async function assertPublishFilesExist(filePaths) {
  const missing = [];
  for (const filePath of filePaths) {
    try {
      await access(filePath);
    } catch {
      missing.push(path.relative(repoRoot, filePath));
    }
  }
  if (missing.length > 0) {
    throw new Error(`Missing publish files: ${missing.join(", ")}`);
  }
}

async function main() {
  const contract = await loadNpmPublishContract(repoRoot);
  if (contract.issues.length > 0) {
    throw new Error(contract.issues.join("\n"));
  }
  await assertPublishFilesExist(contract.requiredPublishFiles);
  process.stdout.write(
    `npm publish contract ok for ${contract.packageJson.name}@${contract.packageJson.version}\n`
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
