import type { RelayInboundMessageEvent, RelayTargetScope } from "../api.js";
import { resolveSessionConversation } from "./session-conversation.js";

export function inferRelayTargetScope(input: {
  targetScope?: RelayTargetScope;
  threadId?: string;
}): RelayTargetScope {
  if (input.targetScope) {
    return input.targetScope;
  }
  return input.threadId ? "topic" : "group";
}

export function mapInboundMessageEvent(frame: {
  payload: {
    accountId: string;
    cursor?: string;
    targetScope?: RelayTargetScope;
    conversation: {
      transportConversationId: string;
      baseConversationId?: string;
      parentConversationCandidates?: string[];
    };
    thread?: {
      threadId?: string;
    };
    message: {
      transportMessageId: string;
      senderId: string;
      text?: string | null;
      attachments?: Array<Record<string, unknown>>;
      replyToTransportMessageId?: string | null;
    };
  };
}): RelayInboundMessageEvent {
  const targetScope = inferRelayTargetScope({
    targetScope: frame.payload.targetScope,
    threadId: frame.payload.thread?.threadId,
  });
  return {
    accountId: frame.payload.accountId,
    cursor: frame.payload.cursor,
    sessionConversation: resolveSessionConversation({
      targetScope,
      transportConversationId: frame.payload.conversation.transportConversationId,
      baseConversationId: frame.payload.conversation.baseConversationId,
      parentConversationCandidates: frame.payload.conversation.parentConversationCandidates,
      threadId: frame.payload.thread?.threadId,
    }),
    targetScope,
    senderId: frame.payload.message.senderId,
    text: frame.payload.message.text ?? null,
    transportMessageId: frame.payload.message.transportMessageId,
    replyToTransportMessageId: frame.payload.message.replyToTransportMessageId ?? null,
    attachments: frame.payload.message.attachments as Array<Record<string, never>> | undefined,
  };
}
