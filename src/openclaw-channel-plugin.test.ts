import { describe, expect, it } from "vitest";
import { relayChannelOpenclawPlugin } from "./openclaw-channel-plugin.js";

const cfg = {
  channels: {
    "relay-channel": {
      enabled: true,
      accounts: [{ id: "default", port: 43129 }],
    },
  },
};

describe("relayChannelOpenclawPlugin", () => {
  it("resolves explicit relay targets through messaging fallback", async () => {
    const resolved = await relayChannelOpenclawPlugin.messaging?.targetResolver?.resolveTarget?.({
      cfg,
      accountId: "default",
      input: "telegram:group:-100",
      normalized: "telegram:group:-100",
      preferredKind: "group",
    });

    expect(resolved).toEqual({
      to: "telegram:group:-100",
      kind: "group",
      display: "telegram:group:-100",
      source: "normalized",
    });
  });

  it("supports channels resolve for explicit relay targets", async () => {
    const runtime = {
      log: () => {},
      warn: () => {},
      error: () => {},
      info: () => {},
    };

    const results = await relayChannelOpenclawPlugin.resolver?.resolveTargets({
      cfg,
      accountId: "default",
      inputs: ["telegram:topic:-100#77"],
      kind: "group",
      runtime,
    });

    expect(results).toEqual([
      {
        input: "telegram:topic:-100#77",
        resolved: true,
        id: "telegram:topic:-100",
        name: "telegram:topic:-100#77",
        note: "normalized explicit relay target",
      },
    ]);
  });
});
