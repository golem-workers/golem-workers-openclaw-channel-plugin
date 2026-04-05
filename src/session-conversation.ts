import type { RelaySessionConversation } from "../api.js";

export function resolveSessionConversation(input: {
  conversationHandle?: string;
  baseConversationId?: string | null;
  parentConversationCandidates?: string[];
  threadHandle?: string | null;
  threadId?: string | null;
}): RelaySessionConversation {
  const conversationHandle =
    input.conversationHandle ?? input.baseConversationId ?? "unknown";
  const threadHandle = input.threadHandle ?? input.threadId ?? null;
  const baseConversationId = input.baseConversationId ?? conversationHandle;
  const parentConversationCandidates = input.parentConversationCandidates ?? [baseConversationId];
  const id = buildConversationId(conversationHandle, threadHandle);

  return {
    id,
    conversationHandle,
    threadHandle,
    threadId: input.threadId ?? null,
    baseConversationId,
    parentConversationCandidates,
  };
}

function buildConversationId(conversationHandle: string, threadHandle?: string | null): string {
  if (threadHandle) {
    return `${conversationHandle}#${threadHandle}`;
  }
  return conversationHandle;
}
