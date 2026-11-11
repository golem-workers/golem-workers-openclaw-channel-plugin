import { relayChannelPluginConfigSchema } from "./src/config.js";

type Config = Record<string, unknown>;
const record = (value: unknown): Config =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Config : {};

/** Doctor must be loadable without registering the channel, reading OAuth or
 * starting Relay connections. Supported saved config requires no conversion;
 * validate it but never serialize parsed defaults or strip authored settings. */
export function normalizeCompatibilityConfig<T extends Config>({ cfg }: { cfg: T }): {
  config: T; changes: string[]; warnings?: string[];
} {
  const entry = record(record(record(cfg.plugins).entries)["relay-channel"]);
  if (entry.config !== undefined && !relayChannelPluginConfigSchema.strict().safeParse(entry.config).success) {
    return {
      config: cfg, changes: [],
      warnings: ["relay-channel: saved plugin configuration is unsupported; repair plugins.entries.relay-channel.config before completing the upgrade."],
    };
  }
  return { config: cfg, changes: [] };
}

// This plugin does not own core session-store migrations. OAuth and pool state
// stay with their existing owners; Doctor must not move or rewrite those files.
export const stateMigrations: never[] = [];
