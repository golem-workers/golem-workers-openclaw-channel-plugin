import type { RelayResolvedTarget, RelayTargetScope } from "../api.js";

type ParsedExplicitTarget = {
  channel: string;
  scope: RelayTargetScope;
  conversationId: string;
  threadId?: string | null;
};

export function normalizeTarget(input: string): string {
  return input.trim().replace(/\s+/g, " ").toLowerCase();
}

export function parseExplicitTarget(input: string): ParsedExplicitTarget | null {
  const normalized = normalizeTarget(input);
  const match = normalized.match(
    /^(?<channel>[a-z0-9_-]+):(?<scope>dm|group|topic):(?<conversationId>[^#]+?)(?:#(?<threadId>[^#]+))?$/
  );
  if (!match?.groups) {
    return null;
  }

  return {
    channel: match.groups.channel,
    scope: match.groups.scope as RelayTargetScope,
    conversationId: match.groups.conversationId,
    threadId: match.groups.threadId ?? null,
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
      to: `${explicit.channel}:${explicit.scope}:${explicit.conversationId}`,
      kind: explicit.scope,
      display: formatDisplay(explicit.channel, explicit.scope, explicit.conversationId, explicit.threadId),
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
    to: `relay:${scope}:${transportId}`,
    kind: scope,
    display: transportId,
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
    target.transportTarget.chatId ?? target.to,
    target.threadId ?? null
  );
}

function formatDisplay(
  channel: string,
  scope: RelayTargetScope,
  conversationId: string,
  threadId?: string | null
): string {
  if (threadId) {
    return `${channel}:${scope}:${conversationId}#${threadId}`;
  }
  return `${channel}:${scope}:${conversationId}`;
}
