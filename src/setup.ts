import type { RelayChannelPluginConfig, RelaySetupInspection } from "../api.js";

export function inspectRelaySetup(config: RelayChannelPluginConfig): RelaySetupInspection {
  const warnings: string[] = [];
  if (!config.enabled) {
    warnings.push("Plugin is disabled.");
  }
  if ((config.dmSecurityPolicy?.mode ?? "allow_all") === "allow_list" &&
      (config.dmSecurityPolicy?.allowedTargets?.length ?? 0) === 0) {
    warnings.push("DM allow-list mode is enabled without allowed targets.");
  }
  if ((config.directory?.enabled ?? true) === false) {
    warnings.push("Directory lookup is disabled; explicit targets only.");
  }

  return {
    ok: warnings.length === 0,
    warnings,
    resolvedAccounts: config.accounts.map((account) => account.id),
  };
}
