import { describe, expect, it } from "vitest";
import { normalizeCompatibilityConfig, stateMigrations } from "../doctor-contract-api.js";

const fixture = (config: unknown) => ({
  agents: { defaults: { model: { primary: "codex/example", fallbacks: ["other/model"] }, thinkingDefault: "high" } },
  auth: { profiles: { existing: { mode: "oauth" } } },
  plugins: { entries: { "relay-channel": { enabled: true, hooks: { allowConversationAccess: true }, config }, other: { config: { keep: true } } } },
});

describe("metadata-only native Doctor contract", () => {
  it.each([{}, { accounts: [{ id: "default", port: 43129 }] }, { url: "ws://127.0.0.1:43129", requestTimeoutMs: 12000, accounts: [{ id: "default", metadata: { preserve: "yes" } }] }])("confirms supported saved config without writing defaults or changing other settings", config => {
    const cfg = fixture(config); const before = structuredClone(cfg);
    const result = normalizeCompatibilityConfig({ cfg });
    expect(result).toEqual({ config: cfg, changes: [] });
    expect(result.config).toBe(cfg); expect(cfg).toEqual(before);
    expect(cfg.plugins.entries["relay-channel"].config).toBe(config);
  });
  it("accepts an absent install-time config without creating it", () => {
    const cfg = { plugins: { entries: { "relay-channel": { enabled: true } } } };
    expect(normalizeCompatibilityConfig({ cfg })).toEqual({ config: cfg, changes: [] });
    expect(cfg.plugins.entries["relay-channel"]).not.toHaveProperty("config");
  });
  it.each([null, [], "secret-value-do-not-log", { accounts: [{ id: "" }] }, { port: -1 }, { unknownSecret: "secret-value-do-not-log" }])("refuses unsupported saved config and never erases or exposes it", config => {
    const cfg = fixture(config); const before = structuredClone(cfg);
    const result = normalizeCompatibilityConfig({ cfg });
    expect(result.warnings).toHaveLength(1); expect(result.changes).toEqual([]);
    expect(result.config).toBe(cfg); expect(cfg).toEqual(before);
    expect(JSON.stringify(result.warnings)).not.toContain("secret-value-do-not-log");
  });
  it("declares no core session-store migrations", () => { expect(stateMigrations).toEqual([]); });
});
