import type { RelayCapabilitySnapshot, RelayMessageToolDescription } from "../api.js";
import { OPTIONAL_CAPABILITY_TO_ACTION } from "./types.js";

const SEND_MESSAGE_SCHEMA = {
  type: "object",
  additionalProperties: true,
  properties: {
    action: {
      type: "string",
      enum: ["send"],
      description: "Send a message through the relay transport.",
    },
    target: {
      type: "string",
      description: "Provider-prefixed target, for example telegram:123456789.",
    },
    to: {
      type: "string",
      description: "Alias for target.",
    },
    message: {
      type: "string",
      description: "Text or caption to send. With multiple media files, this is attached to the first item.",
    },
    content: {
      type: "string",
      description: "Alias for message.",
    },
    media: {
      type: "string",
      description: "Single media/file path or URL.",
    },
    mediaUrl: {
      type: "string",
      description: "Single media/file path or URL.",
    },
    path: {
      type: "string",
      description: "Single local file path alias.",
    },
    filePath: {
      type: "string",
      description: "Single local file path alias.",
    },
    mediaUrls: {
      type: "array",
      items: { type: "string" },
      description: "Multiple media/file paths or URLs to send together.",
    },
    attachments: {
      type: "array",
      description: "Multiple attachment objects. Each object may contain mediaUrl, path, filePath, fileUrl, or url.",
      items: {
        type: "object",
        additionalProperties: true,
        properties: {
          mediaUrl: { type: "string" },
          path: { type: "string" },
          filePath: { type: "string" },
          fileUrl: { type: "string" },
          url: { type: "string" },
          fileName: { type: "string" },
          contentType: { type: "string" },
        },
      },
    },
    replyTo: {
      type: "string",
      description: "Transport message id to reply to.",
    },
    threadId: {
      type: ["string", "number"],
      description: "Transport thread/topic id.",
    },
    forceDocument: {
      type: "boolean",
      description: "Send media as documents/files when supported.",
    },
    asDocument: {
      type: "boolean",
      description: "Alias for forceDocument.",
    },
    asVoice: {
      type: "boolean",
      description: "Send audio media as a voice note when supported.",
    },
    silent: {
      type: "boolean",
      description: "Request silent delivery when supported.",
    },
  },
};

const MESSAGE_TOOL_CAPABILITIES = [
  "media",
  "attachments",
  "multiMedia",
  "documents",
  "replyTo",
  "thread",
  "silent",
  "forceDocument",
];

export function describeMessageTool(
  capabilities: RelayCapabilitySnapshot | undefined,
  scope?: string
): RelayMessageToolDescription {
  const actions = ["send"];
  if (!capabilities) {
    return {
      actions,
      capabilities: MESSAGE_TOOL_CAPABILITIES,
      schema: [SEND_MESSAGE_SCHEMA],
    };
  }

  for (const [capability, action] of Object.entries(OPTIONAL_CAPABILITY_TO_ACTION)) {
    if (hasCapability(capabilities, capability, scope)) {
      actions.push(action);
    }
  }

  return {
    actions: [...new Set(actions)],
    capabilities: MESSAGE_TOOL_CAPABILITIES,
    schema: [SEND_MESSAGE_SCHEMA],
  };
}

function hasCapability(
  capabilities: RelayCapabilitySnapshot,
  capability: string,
  scope?: string
): boolean {
  if (scope && capabilities.targetCapabilities?.[scope]?.[capability] !== undefined) {
    return Boolean(capabilities.targetCapabilities[scope]?.[capability]);
  }
  return Boolean(
    capabilities.optionalCapabilities[capability] ??
      capabilities.providerCapabilities[capability]
  );
}
