import type { RelayResolvedTarget } from "../api.js";

export function resolveOutboundSessionRoute(input: {
  resolvedTarget: RelayResolvedTarget;
  replyToTransportMessageId?: string | null;
  explicitThreadId?: string | null;
}) {
  const threadId = input.explicitThreadId ?? input.resolvedTarget.threadId ?? null;
  const baseConversationId = input.resolvedTarget.transportTarget.chatId ?? input.resolvedTarget.to;
  const conversationId =
    input.resolvedTarget.kind === "topic" && threadId
      ? `${baseConversationId}:topic:${threadId}`
      : baseConversationId;

  return {
    targetScope: input.resolvedTarget.kind,
    conversationId,
    baseConversationId,
    threadId,
    replyToTransportMessageId: input.replyToTransportMessageId ?? null,
  };
}
