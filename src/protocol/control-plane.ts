import { z } from "zod";

export const relayTransportSchema = z.object({
  provider: z.string(),
  providerVersion: z.string().optional(),
});

export const capabilityMapSchema = z.record(z.string(), z.boolean());

export const capabilitySnapshotSchema = z.object({
  coreCapabilities: capabilityMapSchema,
  optionalCapabilities: capabilityMapSchema,
  providerCapabilities: capabilityMapSchema,
  targetCapabilities: z.record(z.string(), capabilityMapSchema).optional(),
  limits: z.object({
    maxUploadBytes: z.number().int().positive().optional(),
    maxCaptionBytes: z.number().int().positive().optional(),
    maxPollOptions: z.number().int().positive().optional(),
  }),
  transport: relayTransportSchema,
});

export const helloRequestSchema = z.object({
  type: z.literal("hello"),
  protocolVersion: z.literal(1),
  role: z.literal("openclaw-channel-plugin"),
  channelId: z.string(),
  instanceId: z.string(),
  accountId: z.string(),
  supports: z.object({
    asyncLifecycle: z.boolean(),
    fileDownloadRequests: z.boolean(),
    capabilityNegotiation: z.boolean(),
    accountScopedStatus: z.boolean(),
  }),
  requestedCapabilities: z.object({
    core: z.array(z.string()),
    optional: z.array(z.string()),
  }),
});

export const helloResponseSchema = z.object({
  type: z.literal("hello"),
  protocolVersion: z.literal(1),
  role: z.literal("local-relay"),
  relayInstanceId: z.string(),
  accountId: z.string(),
  transport: relayTransportSchema,
  coreCapabilities: capabilityMapSchema,
  optionalCapabilities: capabilityMapSchema,
  providerCapabilities: capabilityMapSchema,
  targetCapabilities: z.record(z.string(), capabilityMapSchema).optional(),
  limits: z.object({
    maxUploadBytes: z.number().int().positive().optional(),
    maxCaptionBytes: z.number().int().positive().optional(),
    maxPollOptions: z.number().int().positive().optional(),
  }),
  dataPlane: z.object({
    uploadBaseUrl: z.string().url(),
    downloadBaseUrl: z.string().url(),
  }),
});

export const transportTargetSchema = z.record(z.string(), z.string());

export const transportActionSchema = z.object({
  actionId: z.string(),
  kind: z.enum([
    "message.send",
    "message.edit",
    "message.delete",
    "reaction.set",
    "typing.set",
    "poll.send",
    "message.pin",
    "message.unpin",
    "topic.create",
    "topic.edit",
    "topic.close",
    "callback.answer",
    "file.download.request",
  ]),
  idempotencyKey: z.string(),
  accountId: z.string(),
  targetScope: z.enum(["dm", "group", "topic"]),
  transportTarget: transportTargetSchema,
  conversation: z.object({
    transportConversationId: z.string(),
    baseConversationId: z.string().nullable().optional(),
    parentConversationCandidates: z.array(z.string()).optional(),
  }),
  thread: z.object({
    threadId: z.string().nullable().optional(),
  }).optional(),
  reply: z.object({
    replyToTransportMessageId: z.string().nullable().optional(),
  }).optional(),
  payload: z.record(z.string(), z.unknown()),
  openclawContext: z.object({
    sessionKey: z.string().optional(),
    runId: z.string().optional(),
  }).optional(),
});

export const transportActionRequestSchema = z.object({
  type: z.literal("request"),
  requestType: z.literal("transport.action"),
  requestId: z.string(),
  action: transportActionSchema,
});

const eventPayloadBaseSchema = z.object({
  requestId: z.string().optional(),
  actionId: z.string().optional(),
  cursor: z.string().optional(),
});

export const transportActionAcceptedEventSchema = z.object({
  type: z.literal("event"),
  eventType: z.literal("transport.action.accepted"),
  payload: eventPayloadBaseSchema.extend({
    requestId: z.string(),
    actionId: z.string(),
  }),
});

export const transportActionProgressEventSchema = z.object({
  type: z.literal("event"),
  eventType: z.enum([
    "transport.action.progress",
    "transport.action.uploading",
    "transport.action.waiting_rate_limit",
  ]),
  payload: eventPayloadBaseSchema.extend({
    requestId: z.string(),
    actionId: z.string(),
  }),
});

export const transportActionCompletedEventSchema = z.object({
  type: z.literal("event"),
  eventType: z.literal("transport.action.completed"),
  payload: eventPayloadBaseSchema.extend({
    requestId: z.string(),
    actionId: z.string(),
    result: z.object({
      transportMessageId: z.string().optional(),
      conversationId: z.string().optional(),
      threadId: z.string().optional(),
      uploadUrl: z.string().url().optional(),
      downloadUrl: z.string().url().optional(),
      token: z.string().optional(),
    }),
  }),
});

export const transportActionFailedEventSchema = z.object({
  type: z.literal("event"),
  eventType: z.literal("transport.action.failed"),
  payload: eventPayloadBaseSchema.extend({
    requestId: z.string(),
    actionId: z.string(),
    error: z.object({
      code: z.string(),
      message: z.string(),
      retryable: z.boolean(),
      retryAfterMs: z.number().int().nonnegative().optional(),
    }),
  }),
});

export const transportMessageReceivedEventSchema = z.object({
  type: z.literal("event"),
  eventType: z.literal("transport.message.received"),
  payload: z.object({
    eventId: z.string(),
    accountId: z.string(),
    cursor: z.string().optional(),
    conversation: z.object({
      transportConversationId: z.string(),
      baseConversationId: z.string().optional(),
      parentConversationCandidates: z.array(z.string()).optional(),
    }),
    thread: z.object({
      threadId: z.string().optional(),
    }).optional(),
    message: z.object({
      transportMessageId: z.string(),
      senderId: z.string(),
      text: z.string().nullable().optional(),
      caption: z.string().nullable().optional(),
      attachments: z.array(z.record(z.string(), z.unknown())).default([]),
      editedAtMs: z.number().int().nullable().optional(),
      replyToTransportMessageId: z.string().nullable().optional(),
    }),
  }),
});

export const transportAccountStatusEventSchema = z.object({
  type: z.literal("event"),
  eventType: z.enum([
    "transport.account.connecting",
    "transport.account.ready",
    "transport.account.degraded",
    "transport.account.disconnected",
    "transport.account.status",
  ]),
  payload: z.object({
    accountId: z.string(),
    state: z.enum(["connecting", "healthy", "degraded", "stopped"]),
    reason: z.string().optional(),
  }),
});

export const transportCapabilitiesUpdatedEventSchema = z.object({
  type: z.literal("event"),
  eventType: z.literal("transport.capabilities.updated"),
  payload: capabilitySnapshotSchema,
});

export const replayRequestSchema = z.object({
  type: z.literal("request"),
  requestType: z.literal("transport.replay"),
  requestId: z.string(),
  cursor: z.string(),
});

export const replayGapEventSchema = z.object({
  type: z.literal("event"),
  eventType: z.literal("transport.replay.gap"),
  payload: z.object({
    fromCursor: z.string(),
    toCursor: z.string(),
    reason: z.string(),
  }),
});

export const protocolErrorSchema = z.object({
  type: z.literal("event"),
  eventType: z.literal("transport.protocol.error"),
  payload: z.object({
    code: z.string(),
    message: z.string(),
  }),
});

export const controlPlaneEventSchema = z.union([
  transportActionAcceptedEventSchema,
  transportActionProgressEventSchema,
  transportActionCompletedEventSchema,
  transportActionFailedEventSchema,
  transportMessageReceivedEventSchema,
  transportAccountStatusEventSchema,
  transportCapabilitiesUpdatedEventSchema,
  replayGapEventSchema,
  protocolErrorSchema,
]);

export function parseControlPlaneMessage(input: string) {
  const parsed = JSON.parse(input) as unknown;
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    "type" in parsed &&
    (parsed as { type?: string }).type === "hello"
  ) {
    return helloResponseSchema.parse(parsed);
  }
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    "type" in parsed &&
    (parsed as { type?: string }).type === "event"
  ) {
    return controlPlaneEventSchema.parse(parsed);
  }
  throw new Error("Unsupported control-plane frame");
}
