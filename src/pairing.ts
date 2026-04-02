import type { RelayChannelPluginConfig } from "../api.js";

export function canPairTarget(config: RelayChannelPluginConfig, target: string): boolean {
  void target;
  return (config.pairing?.mode ?? "same_chat_only") !== "disabled";
}
