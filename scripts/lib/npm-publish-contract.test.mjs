import { describe, expect, it } from "vitest";
import {
  collectNpmPublishContractIssues,
  EXPECTED_NPM_PACKAGE_NAME,
} from "./npm-publish-contract.mjs";

function basePackageJson() {
  return {
    name: EXPECTED_NPM_PACKAGE_NAME,
    version: "1.0.45",
    description: "Golem Workers relay-backed OpenClaw channel plugin",
    repository: {
      url: "git+https://github.com/golem-workers/golem-workers-openclaw-channel-plugin.git",
    },
    openclaw: {
      install: {
        npmSpec: EXPECTED_NPM_PACKAGE_NAME,
      },
      compat: {
        pluginApi: ">=1.0.0",
      },
      build: {
        openclawVersion: "2026.5.18",
      },
      release: {
        publishToNpm: true,
      },
    },
  };
}

function baseManifest() {
  return {
    id: "relay-channel",
    kind: "channel",
    doctorContract: { configRepair: true, stateMigrations: [] },
    channels: ["relay-channel"],
    channelConfigs: {
      "relay-channel": {
        label: "Relay Channel",
        schema: {
          type: "object",
          properties: {
            accounts: {
              type: "array",
            },
          },
        },
      },
    },
  };
}

describe("collectNpmPublishContractIssues", () => {
  it("accepts a publishable package contract", () => {
    expect(
      collectNpmPublishContractIssues({
        packageJson: basePackageJson(),
        manifest: baseManifest(),
      })
    ).toEqual([]);
  });

  it("refuses a release without a usable Doctor declaration", () => {
    const manifest = baseManifest(); delete manifest.doctorContract;
    expect(collectNpmPublishContractIssues({ packageJson: basePackageJson(), manifest })).toContain(
      "openclaw.plugin.json must declare the config-repair Doctor contract and an empty core state-migration inventory"
    );
  });

  it("rejects private packages and wrong npm spec", () => {
    const packageJson = basePackageJson();
    packageJson.private = true;
    packageJson.openclaw.install.npmSpec = "@openclaw/relay-channel";

    const issues = collectNpmPublishContractIssues({
      packageJson,
      manifest: baseManifest(),
    });

    expect(issues).toContain("package.json must not be private for npm publish");
    expect(issues).toContain(`openclaw.install.npmSpec must be ${EXPECTED_NPM_PACKAGE_NAME}`);
  });
});
