import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildAgentBundle } from "./build-agent-bundle.mjs";

describe("buildAgentBundle", () => {
  it("leaves dependency installation to the OpenClaw archive installer", async () => {
    const outputDir = await mkdtemp(path.join(tmpdir(), "relay-channel-bundle-test-"));
    const outputPath = path.join(outputDir, "relay-channel.tgz");

    try {
      await buildAgentBundle({ outputPath, skipBuild: true });

      const entries = execFileSync("tar", ["-tzf", outputPath], { encoding: "utf8" })
        .trim()
        .split("\n");

      expect(entries).toContain("relay-channel/package.json");
      expect(entries).toContain("relay-channel/package-lock.json");
      expect(entries.some((entry) => entry.startsWith("relay-channel/node_modules/"))).toBe(false);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });
});
