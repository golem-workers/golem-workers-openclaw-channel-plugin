import type { RelayResolvedTarget } from "../api.js";

export function resolveOutboundSessionRoute(input: {
  resolvedTarget: RelayResolvedTarget;
  replyToTransportMessageId?: string | null;
  explicitThreadId?: string | null;
}) {
  const threadHandle =
    input.explicitThreadId ??
    input.resolvedTarget.threadHandle ??
    input.resolvedTarget.threadId ??
    null;
  const conversationHandle =
    input.resolvedTarget.conversationHandle ??
    input.resolvedTarget.transportTarget.chatId ??
    input.resolvedTarget.to;
  const baseConversationId = conversationHandle;
  const conversationId = threadHandle ? `${conversationHandle}#${threadHandle}` : conversationHandle;

  return {
    conversationHandle,
    conversationId,
    baseConversationId,
    threadHandle,
    threadId: input.explicitThreadId ?? input.resolvedTarget.threadId ?? null,
    replyToTransportMessageId: input.replyToTransportMessageId ?? null,
  };
}
