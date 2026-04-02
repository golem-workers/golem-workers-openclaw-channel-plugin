import type { RelayChannelPluginConfig, RelaySecurityDecision } from "../api.js";

export function evaluateDirectMessageSecurity(
  config: RelayChannelPluginConfig,
  target: string
): RelaySecurityDecision {
  const policy = config.dmSecurityPolicy ?? { mode: "allow_all", allowedTargets: [] };
  if (policy.mode === "allow_all") {
    return { allowed: true };
  }

  const normalizedTarget = target.trim().toLowerCase();
  const isAllowed = (policy.allowedTargets ?? []).some(
    (entry) => entry.trim().toLowerCase() === normalizedTarget
  );

  return isAllowed
    ? { allowed: true }
    : { allowed: false, reason: "DM target is not present in the allow-list." };
}
