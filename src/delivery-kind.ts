export type RelayDeliveryKind = "tool" | "block" | "final";

export type RelayDeliveryKindSource = "message-adapter" | "outbound";

const TOOL_PROGRESS_PREFIXES = ["🛠️", "🔧", "🔎", "📖"] as const;

function readPayloadText(payload: Record<string, unknown> | null | undefined): string {
  if (!payload) {
    return "";
  }
  return typeof payload.text === "string" ? payload.text.trim() : "";
}

export function looksLikeToolProgressText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  return TOOL_PROGRESS_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

export function inferRelayDeliveryKind(input: {
  source: RelayDeliveryKindSource;
  text?: string | null;
  payload?: Record<string, unknown> | null;
}): RelayDeliveryKind {
  if (input.source === "message-adapter") {
    return "final";
  }
  const payload = input.payload ?? null;
  if (payload?.isReasoning === true) {
    return "block";
  }
  const text = (typeof input.text === "string" ? input.text : readPayloadText(payload)).trim();
  if (looksLikeToolProgressText(text)) {
    return "tool";
  }
  return "final";
}
