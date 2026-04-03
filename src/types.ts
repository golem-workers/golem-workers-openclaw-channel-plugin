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
  messageEdit: "edit",
  messageDelete: "delete",
  reactions: "react",
  typing: "typing",
  polls: "poll",
  pinning: "pin",
  fileDownloads: "download",
  "telegram.inlineButtons": "buttons",
  "telegram.forumTopics": "topics",
  "telegram.callbackAnswer": "callback_answer",
  nativeApprovalDelivery: "approval_native_delivery",
};

export type RelayPluginContext = {
  config: RelayChannelPluginConfig;
  statusByAccount: Map<string, RelayAccountStatus>;
  capabilityByAccount: Map<string, RelayCapabilitySnapshot>;
};
