import type { RelaySessionConversation, RelayTargetScope } from "../api.js";

export function resolveSessionConversation(input: {
  targetScope: RelayTargetScope;
  transportConversationId: string;
  baseConversationId?: string | null;
  parentConversationCandidates?: string[];
  threadId?: string | null;
}): RelaySessionConversation {
  const baseConversationId = input.baseConversationId ?? input.transportConversationId;
  const parentConversationCandidates = input.parentConversationCandidates ?? [baseConversationId];
  const id = buildConversationId(
    input.targetScope,
    input.transportConversationId,
    input.threadId ?? null
  );

  return {
    id,
    threadId: input.threadId ?? null,
    baseConversationId,
    parentConversationCandidates,
  };
}

function buildConversationId(
  targetScope: RelayTargetScope,
  transportConversationId: string,
  threadId?: string | null
): string {
  if (targetScope === "topic" && threadId) {
    return `${transportConversationId}:topic:${threadId}`;
  }
  return transportConversationId;
}
