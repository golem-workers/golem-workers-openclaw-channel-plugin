import type { RelayResolvedTarget, RelayTargetScope } from "../api.js";

type ParsedExplicitTarget = {
  channel: string;
  scope?: RelayTargetScope;
  conversationId: string;
  threadId?: string | null;
};

export function normalizeTarget(input: string): string {
  return input.trim().replace(/\s+/g, " ").toLowerCase();
}

export function parseExplicitTarget(input: string): ParsedExplicitTarget | null {
  const normalized = normalizeTarget(input);
  const legacyMatch = normalized.match(
    /^(?<channel>[a-z0-9_-]+):(?<scope>dm|group|topic):(?<conversationId>[^#]+?)(?:#(?<threadId>[^#]+))?$/
  );
  if (legacyMatch?.groups) {
    return {
      channel: legacyMatch.groups.channel,
      scope: legacyMatch.groups.scope as RelayTargetScope,
      conversationId: legacyMatch.groups.conversationId,
      threadId: legacyMatch.groups.threadId ?? null,
    };
  }
  const opaqueMatch = normalized.match(
    /^(?<channel>[a-z0-9_-]+):(?<conversationId>[^#]+?)(?:#(?<threadId>[^#]+))?$/
  );
  if (!opaqueMatch?.groups) {
    return null;
  }
  return {
    channel: opaqueMatch.groups.channel,
    conversationId: opaqueMatch.groups.conversationId,
    threadId: opaqueMatch.groups.threadId ?? null,
  };
}

export function inferTargetChatType(input: string): RelayTargetScope {
  const normalized = normalizeTarget(input);
  if (normalized.includes("#")) {
    return "topic";
  }
  if (normalized.startsWith("@") || normalized.startsWith("user:")) {
    return "dm";
  }
  return "group";
}

export function resolveTarget(input: string): RelayResolvedTarget {
  const explicit = parseExplicitTarget(input);
  if (explicit) {
    return {
      to: explicit.scope
        ? `${explicit.channel}:${explicit.scope}:${explicit.conversationId}`
        : `${explicit.channel}:${explicit.conversationId}`,
      kind: explicit.scope,
      display: formatDisplay(explicit.channel, explicit.scope, explicit.conversationId, explicit.threadId),
      conversationHandle: explicit.conversationId,
      threadHandle: explicit.threadId ?? null,
      threadId: explicit.threadId,
      transportTarget: {
        channel: explicit.channel,
        chatId: explicit.conversationId,
      },
    };
  }

  const scope = inferTargetChatType(input);
  const normalized = normalizeTarget(input);
  const transportId = normalized.replace(/^@/, "user:");
  return {
    to: `relay:${transportId}`,
    kind: scope,
    display: transportId,
    conversationHandle: transportId,
    threadHandle: null,
    threadId: null,
    transportTarget: {
      channel: "relay",
      chatId: transportId,
    },
  };
}

export function formatTargetDisplay(target: RelayResolvedTarget): string {
  return formatDisplay(
    target.transportTarget.channel ?? "relay",
    target.kind,
    target.conversationHandle ?? target.transportTarget.chatId ?? target.to,
    target.threadHandle ?? target.threadId ?? null
  );
}

function formatDisplay(
  channel: string,
  scope: RelayTargetScope | undefined,
  conversationId: string,
  threadId?: string | null
): string {
  const prefix = scope ? `${channel}:${scope}:${conversationId}` : `${channel}:${conversationId}`;
  if (threadId) {
    return `${prefix}#${threadId}`;
  }
  return prefix;
}
