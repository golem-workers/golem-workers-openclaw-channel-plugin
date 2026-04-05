import type {
  RelayAccountStatus,
  RelayCapabilitySnapshot,
  RelayChannelPluginConfig,
} from "../api.js";

export const REQUIRED_CORE_CAPABILITIES = [
  "messageSend",
  "mediaSend",
  "inboundMessages",
  "replyTo",
  "threadRouting",
] as const;

export const OPTIONAL_CAPABILITY_TO_ACTION: Record<string, string> = {
  reactions: "react",
  typing: "typing",
  pinning: "pin",
  fileDownloads: "download",
  nativeApprovalDelivery: "approval_native_delivery",
};

export type RelayPluginContext = {
  config: RelayChannelPluginConfig;
  statusByAccount: Map<string, RelayAccountStatus>;
  capabilityByAccount: Map<string, RelayCapabilitySnapshot>;
};
