import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildAgentBundle } from "./build-agent-bundle.mjs";

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

describe("buildAgentBundle", () => {
  it("leaves dependency installation to the OpenClaw plugin installer", async () => {
    const outputDirectory = await mkdtemp(path.join(tmpdir(), "relay-channel-bundle-"));
    temporaryDirectories.push(outputDirectory);
    const outputPath = path.join(outputDirectory, "relay-channel-bundle.tgz");

    await buildAgentBundle({ outputPath, skipBuild: true });

    const listing = spawnSync("tar", ["-tzf", outputPath], { encoding: "utf8" });
    expect(listing.status, listing.stderr).toBe(0);
    const entries = listing.stdout.trim().split("\n");
    expect(entries).toContain("relay-channel/package.json");
    expect(entries).toContain("relay-channel/package-lock.json");
    expect(entries).toContain("relay-channel/dist/index.js");
    expect(entries.some((entry) => entry.includes("/node_modules/"))).toBe(false);

    const packageJson = spawnSync(
      "tar",
      ["-xOf", outputPath, "relay-channel/package.json"],
      { encoding: "utf8" }
    );
    expect(packageJson.status, packageJson.stderr).toBe(0);
    expect(JSON.parse(packageJson.stdout).dependencies).toEqual({ zod: "^4.3.6" });
    expect(await readFile(outputPath)).not.toHaveLength(0);
  });
});
