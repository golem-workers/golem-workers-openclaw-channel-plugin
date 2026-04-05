import type { RelayInboundMessageEvent } from "../api.js";
import { resolveSessionConversation } from "./session-conversation.js";

export function mapInboundMessageEvent(frame: {
  payload: {
    accountId: string;
    cursor?: string;
    conversation: {
      handle?: string;
      transportConversationId?: string;
      baseConversationId?: string;
      parentConversationCandidates?: string[];
    };
    thread?: {
      handle?: string;
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
  return {
    accountId: frame.payload.accountId,
    cursor: frame.payload.cursor,
    sessionConversation: resolveSessionConversation({
      conversationHandle:
        frame.payload.conversation.handle ?? frame.payload.conversation.transportConversationId,
      baseConversationId: frame.payload.conversation.baseConversationId,
      parentConversationCandidates: frame.payload.conversation.parentConversationCandidates,
      threadHandle: frame.payload.thread?.handle ?? frame.payload.thread?.threadId,
      threadId: frame.payload.thread?.threadId,
    }),
    senderId: frame.payload.message.senderId,
    text: frame.payload.message.text ?? null,
    transportMessageId: frame.payload.message.transportMessageId,
    replyToTransportMessageId: frame.payload.message.replyToTransportMessageId ?? null,
    attachments: frame.payload.message.attachments as Array<Record<string, never>> | undefined,
  };
}
