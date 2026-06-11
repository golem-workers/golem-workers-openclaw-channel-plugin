import type { RelayChannelPluginConfig } from "../api.js";
import { logRuntimeEvent } from "./runtime-log.js";

export type SelfNudgeSettings = {
  enabled: boolean;
  analyzedRecentMessageCount: number;
  baseTimeoutMs: number;
  model?: string;
};

export type OpenClawSessionSummary = {
  id: string;
  updatedAtMs: number;
};

export type OpenClawSessionMessage = {
  id?: string;
  role: string;
  content: string;
};

export type SelfNudgeDecision = {
  nudgeNeeded: boolean;
  body?: string;
};

type RuntimeLike = Record<string, unknown>;

type SelfNudgeControllerState = {
  consecutiveNudgesWithoutUserReply: number;
  lastObservedUserMessageId: string | null;
  lastNudgeAtMs: number | null;
  lastDecision: SelfNudgeDecision | null;
  nextDelayMs: number | null;
};

export function resolveSelfNudgeSettings(config: RelayChannelPluginConfig): SelfNudgeSettings {
  const raw = config.selfNudge ?? {};
  return {
    enabled: raw.enabled === true,
    analyzedRecentMessageCount: Math.max(0, Math.min(20, Math.trunc(raw.analyzedRecentMessageCount ?? 0))),
    baseTimeoutMs: Math.max(10_000, Math.trunc(raw.baseTimeoutMs ?? 300_000)),
    ...(raw.model ? { model: raw.model } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readFunction(value: unknown, key: string): ((input?: unknown) => unknown) | null {
  if (!isRecord(value)) return null;
  const fn = value[key];
  return typeof fn === "function" ? (fn as (input?: unknown) => unknown) : null;
}

function normalizeSession(value: unknown): OpenClawSessionSummary | null {
  if (!isRecord(value)) return null;
  const id =
    typeof value.id === "string"
      ? value.id
      : typeof value.sessionId === "string"
        ? value.sessionId
        : typeof value.key === "string"
          ? value.key
          : null;
  if (!id) return null;
  const rawUpdatedAt = value.updatedAt ?? value.lastActivityAt ?? value.createdAt;
  const updatedAtMs =
    rawUpdatedAt instanceof Date
      ? rawUpdatedAt.getTime()
      : typeof rawUpdatedAt === "number"
        ? rawUpdatedAt
        : typeof rawUpdatedAt === "string"
          ? Date.parse(rawUpdatedAt)
          : 0;
  return {
    id,
    updatedAtMs: Number.isFinite(updatedAtMs) ? updatedAtMs : 0,
  };
}

function normalizeMessage(value: unknown): OpenClawSessionMessage | null {
  if (!isRecord(value)) return null;
  const role = typeof value.role === "string" ? value.role : typeof value.kind === "string" ? value.kind : "";
  const content =
    typeof value.content === "string"
      ? value.content
      : typeof value.text === "string"
        ? value.text
        : typeof value.message === "string"
          ? value.message
          : "";
  if (!role || !content) return null;
  return {
    ...(typeof value.id === "string" ? { id: value.id } : {}),
    role,
    content,
  };
}

function pickArrayPayload(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (isRecord(value)) {
    if (Array.isArray(value.sessions)) return value.sessions;
    if (Array.isArray(value.messages)) return value.messages;
    if (Array.isArray(value.items)) return value.items;
  }
  return [];
}

export async function listOpenClawSessions(runtime: RuntimeLike): Promise<OpenClawSessionSummary[]> {
  const sessionsApi = isRecord(runtime.sessions) ? runtime.sessions : runtime;
  const list =
    readFunction(sessionsApi, "list") ??
    readFunction(sessionsApi, "listSessions") ??
    readFunction(sessionsApi, "getSessions");
  if (!list) return [];
  const raw = await list({ limit: 10 });
  return pickArrayPayload(raw)
    .map(normalizeSession)
    .filter((item): item is OpenClawSessionSummary => Boolean(item))
    .sort((left, right) => right.updatedAtMs - left.updatedAtMs);
}

export async function getOpenClawSessionMessages(
  runtime: RuntimeLike,
  sessionId: string,
  limit: number
): Promise<OpenClawSessionMessage[]> {
  const sessionsApi = isRecord(runtime.sessions) ? runtime.sessions : runtime;
  const getMessages =
    readFunction(sessionsApi, "getMessages") ??
    readFunction(sessionsApi, "listMessages") ??
    readFunction(sessionsApi, "getSessionMessages");
  if (!getMessages) return [];
  const raw = await getMessages({ sessionId, id: sessionId, limit });
  return pickArrayPayload(raw)
    .map(normalizeMessage)
    .filter((item): item is OpenClawSessionMessage => Boolean(item))
    .slice(-limit);
}

function parseDecisionText(text: string): SelfNudgeDecision {
  const trimmed = text.trim();
  if (!trimmed) return { nudgeNeeded: false };
  const jsonMatch = trimmed.match(/\{[\s\S]*\}/u);
  const candidate = jsonMatch?.[0] ?? trimmed;
  try {
    const parsed = JSON.parse(candidate) as unknown;
    if (isRecord(parsed)) {
      const nudgeNeeded = parsed.nudgeNeeded === true || parsed.shouldNudge === true;
      const body = typeof parsed.body === "string" ? parsed.body.trim() : "";
      return nudgeNeeded && body ? { nudgeNeeded: true, body } : { nudgeNeeded: false };
    }
  } catch {
    // Fall through to conservative no-op.
  }
  return { nudgeNeeded: false };
}

export async function analyzeSelfNudgeNeed(input: {
  runtime: RuntimeLike;
  settings: SelfNudgeSettings;
  messages: OpenClawSessionMessage[];
}): Promise<SelfNudgeDecision> {
  const llmApi = isRecord(input.runtime.llm) ? input.runtime.llm : input.runtime;
  const generate =
    readFunction(llmApi, "generateText") ??
    readFunction(llmApi, "complete") ??
    readFunction(llmApi, "invoke");
  if (!generate) return { nudgeNeeded: false };
  const transcript = input.messages
    .map((message) => `${message.role}: ${message.content}`)
    .join("\n");
  const prompt = [
    "You are the local self-nudge checker for an OpenClaw agent.",
    "Inspect the latest session messages and decide if the agent should nudge itself to continue.",
    "Return compact JSON only: {\"nudgeNeeded\": boolean, \"body\": string}.",
    "If the latest state is final or no action is needed, return {\"nudgeNeeded\": false}.",
    "",
    transcript,
  ].join("\n");
  const raw = await generate({
    ...(input.settings.model ? { model: input.settings.model } : {}),
    prompt,
    messages: [
      {
        role: "user",
        content: prompt,
      },
    ],
  });
  if (typeof raw === "string") return parseDecisionText(raw);
  if (isRecord(raw)) {
    const text =
      typeof raw.text === "string"
        ? raw.text
        : typeof raw.content === "string"
          ? raw.content
          : typeof raw.output === "string"
            ? raw.output
            : "";
    return parseDecisionText(text);
  }
  return { nudgeNeeded: false };
}

export async function sendSelfNudge(input: {
  runtime: RuntimeLike;
  sessionId: string;
  body: string;
}): Promise<void> {
  const messagesApi = isRecord(input.runtime.messages) ? input.runtime.messages : input.runtime;
  const send =
    readFunction(messagesApi, "sendSelf") ??
    readFunction(messagesApi, "sendSelfMessage") ??
    readFunction(messagesApi, "sendMessage");
  if (!send) {
    throw new Error("SELF_NUDGE_SEND_UNAVAILABLE");
  }
  await send({
    sessionId: input.sessionId,
    id: input.sessionId,
    message: input.body,
    text: input.body,
    source: "relay-channel:self-nudge",
  });
}

function findLastUserMessageId(messages: OpenClawSessionMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user" || message?.role === "human") {
      return message.id ?? `${index}:${message.content}`;
    }
  }
  return null;
}

export async function runSelfNudgeCheck(input: {
  runtime: RuntimeLike;
  settings: SelfNudgeSettings;
  state: SelfNudgeControllerState;
  nowMs?: number;
}): Promise<SelfNudgeControllerState> {
  const sessions = await listOpenClawSessions(input.runtime);
  const freshest = sessions[0];
  if (!freshest) {
    return { ...input.state, lastDecision: { nudgeNeeded: false } };
  }
  const limit = 1 + input.settings.analyzedRecentMessageCount;
  const messages = await getOpenClawSessionMessages(input.runtime, freshest.id, limit);
  const lastUserMessageId = findLastUserMessageId(messages);
  const consecutiveNudgesWithoutUserReply =
    lastUserMessageId && lastUserMessageId !== input.state.lastObservedUserMessageId
      ? 0
      : input.state.consecutiveNudgesWithoutUserReply;
  const decision = await analyzeSelfNudgeNeed({
    runtime: input.runtime,
    settings: input.settings,
    messages,
  });
  if (!decision.nudgeNeeded || !decision.body) {
    return {
      ...input.state,
      consecutiveNudgesWithoutUserReply,
      lastObservedUserMessageId: lastUserMessageId,
      lastDecision: decision,
      nextDelayMs: input.settings.baseTimeoutMs * (consecutiveNudgesWithoutUserReply + 1),
    };
  }
  await sendSelfNudge({
    runtime: input.runtime,
    sessionId: freshest.id,
    body: decision.body,
  });
  const nextConsecutive = consecutiveNudgesWithoutUserReply + 1;
  return {
    consecutiveNudgesWithoutUserReply: nextConsecutive,
    lastObservedUserMessageId: lastUserMessageId,
    lastNudgeAtMs: input.nowMs ?? Date.now(),
    lastDecision: decision,
    nextDelayMs: input.settings.baseTimeoutMs * (nextConsecutive + 1),
  };
}

export class SelfNudgeController {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private state: SelfNudgeControllerState = {
    consecutiveNudgesWithoutUserReply: 0,
    lastObservedUserMessageId: null,
    lastNudgeAtMs: null,
    lastDecision: null,
    nextDelayMs: null,
  };

  public constructor(
    private readonly runtime: RuntimeLike,
    private readonly settings: SelfNudgeSettings
  ) {}

  public start(): void {
    if (!this.settings.enabled || this.timer) return;
    this.schedule(this.settings.baseTimeoutMs);
  }

  public stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  public snapshot(): SelfNudgeControllerState {
    return { ...this.state };
  }

  private schedule(delayMs: number): void {
    this.stop();
    this.state = { ...this.state, nextDelayMs: delayMs };
    this.timer = setTimeout(() => {
      void this.tick();
    }, delayMs);
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      this.state = await runSelfNudgeCheck({
        runtime: this.runtime,
        settings: this.settings,
        state: this.state,
      });
      this.schedule(this.state.nextDelayMs ?? this.settings.baseTimeoutMs);
    } catch (error) {
      logRuntimeEvent("warn", "Self-nudge check failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      this.schedule(this.settings.baseTimeoutMs);
    } finally {
      this.running = false;
    }
  }
}
