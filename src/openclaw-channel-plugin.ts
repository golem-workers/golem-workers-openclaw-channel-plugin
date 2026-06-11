import { createHash } from "node:crypto";

import {
  buildChannelConfigSchema,
  createChannelPluginBase,
  jsonResult,
  readBooleanParam,
  readStringOrNumberParam,
  readStringParam,
  type ChannelPlugin,
  type OpenClawConfig,
} from "../openclaw-sdk.js";
import { RelayAccountRuntime } from "./account-runtime.js";
import { parseRelayChannelPluginConfig, relayChannelPluginConfigSchema, resolveAccountConfig } from "./config.js";
import { describeMessageTool } from "./message-actions.js";
import { resolveOutboundSessionRoute } from "./outbound-session-route.js";
import { logRuntimeEvent } from "./runtime-log.js";
import { inspectRelaySetup } from "./setup.js";
import { RelayStatusRegistry } from "./status.js";
import {
  formatTargetDisplay as formatResolvedTargetDisplay,
  inferTargetChatType,
  normalizeTarget,
  parseExplicitTarget,
  resolveTarget,
} from "./target-resolution.js";
import type { RelayCapabilitySnapshot } from "../api.js";
import { inferRelayDeliveryKind, type RelayDeliveryKindSource } from "./delivery-kind.js";

const CHANNEL_ID = "relay-channel";

type RelayResolvedAccount = ReturnType<typeof resolveAccountConfig> & {
  accountId?: string | null;
};

type RelayChannelSection = {
  enabled?: boolean;
  url?: string;
  port?: number;
  reconnectBackoffMs?: number;
  maxReconnectBackoffMs?: number;
  requestTimeoutMs?: number;
  capabilityRequirements?: {
    core?: string[];
    optional?: string[];
  };
  dmSecurityPolicy?: {
    mode?: "allow_all" | "allow_list";
    allowedTargets?: string[];
  };
  pairing?: {
    mode?: "same_chat_only" | "disabled";
    approvalRequired?: boolean;
  };
  directory?: {
    enabled?: boolean;
  };
  accounts?: Array<{
    id: string;
    url?: string;
    port?: number;
    metadata?: Record<string, unknown>;
  }>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readChannelSection(cfg: OpenClawConfig): RelayChannelSection {
  const channels = isRecord(cfg) && isRecord(cfg.channels) ? cfg.channels : null;
  const section = channels?.[CHANNEL_ID];
  return isRecord(section) ? (section as RelayChannelSection) : {};
}

function parseChannelConfig(cfg: OpenClawConfig) {
  return parseRelayChannelPluginConfig(readChannelSection(cfg));
}

function cloneConfig(cfg: OpenClawConfig): Record<string, unknown> {
  return isRecord(cfg) ? structuredClone(cfg) : {};
}

function resolvePluginAccountId(cfg: OpenClawConfig, accountId?: string | null) {
  return accountId ?? parseChannelConfig(cfg).accounts[0]?.id ?? "default";
}

function mapRelayScopeToDirectoryKind(scope?: "dm" | "group" | "topic") {
  return scope === "dm" ? "user" : "group";
}

function mapRelayScopeToChatType(scope?: "dm" | "group" | "topic") {
  return scope === "dm" ? "direct" : "group";
}

function normalizeThreadId(threadId: string | number | null | undefined) {
  return threadId !== undefined && threadId !== null ? String(threadId) : null;
}

function inferImplicitTargetChannel(
  capabilities: RelayCapabilitySnapshot | undefined,
  scope?: "dm" | "group" | "topic"
): string | null {
  const providers = new Set<string>();
  const scopeProviders = new Set<string>();
  const addProvider = (value: unknown) => {
    if (typeof value !== "string") {
      return;
    }
    const normalized = value.trim().toLowerCase();
    if (!normalized || normalized === "multi" || normalized === "relay") {
      return;
    }
    providers.add(normalized);
  };

  addProvider(capabilities?.transport.provider);
  for (const profile of Object.values(capabilities?.providerProfiles ?? {})) {
    const provider = profile.transport.provider;
    addProvider(provider);
    const normalizedProvider = typeof provider === "string" ? provider.trim().toLowerCase() : "";
    if (
      scope &&
      normalizedProvider &&
      normalizedProvider !== "multi" &&
      normalizedProvider !== "relay" &&
      profile.targetCapabilities?.[scope]
    ) {
      scopeProviders.add(normalizedProvider);
    }
  }
  for (const key of Object.keys(capabilities?.optionalCapabilities ?? {})) {
    if (key.includes(".")) {
      addProvider(key.split(".")[0]);
    }
  }
  for (const key of Object.keys(capabilities?.providerCapabilities ?? {})) {
    if (key.includes(".")) {
      addProvider(key.split(".")[0]);
    }
  }

  if (scopeProviders.size === 1) {
    return [...scopeProviders][0];
  }
  return providers.size === 1 ? [...providers][0] : null;
}

function summarizeResolvedTarget(target: {
  to: string;
  transportTarget?: Record<string, string>;
  kind?: string;
  threadId?: string | null;
}) {
  return {
    to: target.to,
    kind: target.kind ?? null,
    transportChannel: target.transportTarget?.channel ?? null,
    transportChatId: target.transportTarget?.chatId ?? null,
    threadId: target.threadId ?? null,
  };
}

function summarizeOutboundPayload(input: { payload: any; text: string }) {
  const { payload, text } = input;
  const mediaCount = uniqueNonEmptyStrings([
    typeof payload?.mediaUrl === "string" ? payload.mediaUrl : undefined,
    ...readStringArray(payload?.mediaUrls),
    ...collectAttachmentMediaUrls(payload?.attachments),
  ]).length;
  return {
    textLength: text.length,
    hasMediaUrl: typeof payload?.mediaUrl === "string" && payload.mediaUrl.trim().length > 0,
    mediaCount: mediaCount > 0 ? mediaCount : undefined,
    hasSilent: payload?.silent === true,
    hasNativeQuote: isRecord(payload?.nativeQuote),
    hasRichPayload: Boolean(payload?.presentation || payload?.interactive || payload?.channelData),
  };
}

function summarizeMessageActionParams(params: Record<string, unknown>) {
  const mediaCount = collectMessageActionMediaUrls(params).length;
  return {
    hasTarget: typeof params.target === "string" && params.target.trim().length > 0,
    hasTo: typeof params.to === "string" && params.to.trim().length > 0,
    hasMessage:
      typeof params.message === "string" || typeof params.content === "string",
    mediaCount: mediaCount > 0 ? mediaCount : undefined,
    hasTransportMessageId:
      typeof params.messageId === "string" ||
      typeof params.messageId === "number" ||
      typeof params.transportMessageId === "string",
  };
}

function resolveOutboundTarget(
  to: string,
  threadId?: string | number | null,
  defaultChannel?: string | null
) {
  const resolvedTarget = resolveTarget(to, { defaultChannel });
  const normalizedThreadId = normalizeThreadId(threadId);
  return {
    resolvedTarget,
    target: {
      ...resolvedTarget,
      threadId: normalizedThreadId ?? resolvedTarget.threadId ?? null,
    },
    explicitThreadId: normalizedThreadId,
  };
}

function isInternalMessageTarget(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === "gateway-client" || normalized === "webchat" || normalized === "default";
}

function buildToolContextTarget(toolContext?: {
  currentChannelId?: string;
  currentChannelProvider?: string;
}): string {
  const currentChannelId = toolContext?.currentChannelId?.trim() ?? "";
  if (!currentChannelId) {
    return "";
  }
  const currentChannelProvider = toolContext?.currentChannelProvider?.trim() ?? "";
  if (currentChannelProvider && !currentChannelId.includes(":")) {
    return `${currentChannelProvider}:${currentChannelId}`;
  }
  return currentChannelId;
}

function readMessageActionTarget(params: {
  rawParams: Record<string, unknown>;
  toolContext?: { currentChannelId?: string; currentChannelProvider?: string; currentThreadTs?: string };
  defaultChannel?: string | null;
}) {
  const rawTo =
    readStringParam(params.rawParams, "to") ??
    readStringParam(params.rawParams, "target") ??
    readStringParam(params.rawParams, "channelId") ??
    readStringParam(params.rawParams, "targetId");
  const rawChannel = readStringParam(params.rawParams, "channel");
  const contextualTarget = buildToolContextTarget(params.toolContext);
  const to =
    (rawTo && rawTo.includes(":")
      ? rawTo
      : rawChannel && contextualTarget
        ? contextualTarget.includes(":")
          ? contextualTarget
          : `${rawChannel}:${contextualTarget}`
        : rawTo && rawChannel && !isInternalMessageTarget(rawTo)
          ? `${rawChannel}:${rawTo}`
          : rawTo && !isInternalMessageTarget(rawTo)
            ? rawTo
            : contextualTarget) ?? "";
  if (!to) {
    throw new Error("Target is required. Provide `to` explicitly or invoke the action from a conversation context.");
  }
  const threadId =
    readStringOrNumberParam(params.rawParams, "threadId") ?? params.toolContext?.currentThreadTs;
  return resolveOutboundTarget(to, threadId ?? null, params.defaultChannel);
}

function buildOpenClawOutboundResult(
  result: { transportMessageId?: string; conversationId?: string; downloadUrl?: string },
  fallbackMessageId: string
) {
  return {
    channel: CHANNEL_ID,
    messageId: result.transportMessageId ?? result.conversationId ?? result.downloadUrl ?? fallbackMessageId,
    conversationId: result.conversationId,
    meta: result,
  };
}

function sanitizeReplyToTransportMessageId(input: {
  channel?: string;
  replyToId?: string | null;
}): string | null {
  const value = input.replyToId?.trim();
  if (!value) {
    return null;
  }
  if (input.channel === "telegram") {
    return /^\d+$/.test(value) ? value : null;
  }
  return value;
}

function isLocalAttachmentUrl(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }
  if (/^(https?:|mailto:|tel:|#)/i.test(trimmed)) {
    return false;
  }
  return /^(file:\/\/|\/|\.\/|\.\.\/|~\/)/.test(trimmed);
}

function decodeMarkdownUrl(value: string): string {
  try {
    return decodeURI(value);
  } catch {
    return value;
  }
}

function extractTextAttachmentMedia(input: string): {
  text: string;
  mediaUrls: string[];
} {
  const mediaUrls: string[] = [];
  const seen = new Set<string>();
  let text = input.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (match, label: string, rawUrl: string) => {
    const url = decodeMarkdownUrl(rawUrl.trim());
    if (!isLocalAttachmentUrl(url)) {
      return match;
    }
    if (!seen.has(url)) {
      seen.add(url);
      mediaUrls.push(url);
    }
    return label.trim();
  });
  text = text
    .split("\n")
    .map((line) => line.replace(/^\s*Attached:\s*$/i, "Attached").trimEnd())
    .join("\n")
    .trim();
  return { text, mediaUrls };
}

type RelaySdkOutboundPayload = {
  text: string;
  mediaUrls: string[];
  audioAsVoice: boolean;
  forceDocument: boolean;
  silent: boolean;
  nativeQuote?: Record<string, unknown>;
  presentation?: unknown;
  interactive?: unknown;
  channelData?: Record<string, unknown>;
};

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}

function collectAttachmentMediaUrls(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const urls: string[] = [];
  for (const attachment of value) {
    if (!isRecord(attachment)) {
      continue;
    }
    for (const key of ["media", "mediaUrl", "path", "filePath", "fileUrl", "url"]) {
      const candidate = attachment[key];
      if (typeof candidate === "string" && candidate.trim()) {
        urls.push(candidate);
      }
    }
  }
  return urls;
}

function collectMessageActionMediaUrls(params: Record<string, unknown>): string[] {
  return uniqueNonEmptyStrings([
    readStringParam(params, "media", { trim: false }),
    readStringParam(params, "mediaUrl", { trim: false }),
    readStringParam(params, "path", { trim: false }),
    readStringParam(params, "filePath", { trim: false }),
    readStringParam(params, "fileUrl", { trim: false }),
    ...readStringArray(params.mediaUrls),
    ...readStringArray(params.files),
    ...collectAttachmentMediaUrls(params.attachments),
  ]);
}

function uniqueNonEmptyStrings(values: readonly (string | null | undefined)[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value?.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

function renderRichPayloadFallback(payload: Record<string, unknown>): string {
  const lines: string[] = [];
  if (payload.presentation !== undefined) {
    lines.push(`Presentation: ${JSON.stringify(payload.presentation)}`);
  }
  if (payload.interactive !== undefined) {
    lines.push(`Interactive: ${JSON.stringify(payload.interactive)}`);
  }
  return lines.join("\n");
}

function normalizeSdkOutboundPayload(input: {
  text?: string | null;
  mediaUrl?: string | null;
  payload?: Record<string, unknown>;
  audioAsVoice?: boolean;
  forceDocument?: boolean;
  silent?: boolean;
}): RelaySdkOutboundPayload {
  const payload = input.payload ?? {};
  const rawText =
    (typeof payload.text === "string" ? payload.text : undefined) ??
    input.text ??
    "";
  const parsedTextAttachments = input.mediaUrl || payload.mediaUrl ? { text: rawText, mediaUrls: [] } : extractTextAttachmentMedia(rawText);
  const mediaUrls = uniqueNonEmptyStrings([
    input.mediaUrl,
    typeof payload.mediaUrl === "string" ? payload.mediaUrl : undefined,
    ...readStringArray(payload.mediaUrls),
    ...collectAttachmentMediaUrls(payload.attachments),
    ...parsedTextAttachments.mediaUrls,
  ]);
  const richFallback = renderRichPayloadFallback(payload);
  const text = [parsedTextAttachments.text.trim(), richFallback]
    .filter((part) => part.trim().length > 0)
    .join("\n\n");
  const nativeQuote = isRecord(payload.nativeQuote)
    ? payload.nativeQuote
    : isRecord(payload.quote)
      ? payload.quote
      : undefined;
  const channelData = isRecord(payload.channelData) ? payload.channelData : undefined;
  return {
    text,
    mediaUrls,
    audioAsVoice: input.audioAsVoice ?? payload.audioAsVoice === true,
    forceDocument: input.forceDocument ?? payload.forceDocument === true,
    silent: input.silent ?? payload.silent === true,
    ...(nativeQuote ? { nativeQuote } : {}),
    ...(payload.presentation !== undefined ? { presentation: payload.presentation } : {}),
    ...(payload.interactive !== undefined ? { interactive: payload.interactive } : {}),
    ...(channelData ? { channelData } : {}),
  };
}

function buildRelayMessagePayload(input: {
  text: string;
  mediaUrls: string[];
  commonPayload?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    ...(input.text ? { text: input.text } : {}),
    ...(input.mediaUrls.length > 1
      ? { mediaUrls: input.mediaUrls }
      : input.mediaUrls[0]
        ? { mediaUrl: input.mediaUrls[0] }
        : {}),
    ...(input.commonPayload ?? {}),
  };
}

function normalizeRelayOutboundPayload(input: { payload: unknown }): unknown {
  if (!isRecord(input.payload)) {
    return input.payload;
  }
  const mediaUrls = readStringArray(input.payload.mediaUrls);
  if (mediaUrls.length <= 1) {
    return input.payload;
  }
  const channelData = isRecord(input.payload.channelData) ? input.payload.channelData : {};
  return {
    ...input.payload,
    channelData: {
      ...channelData,
      relayChannelMultiMediaPayload: true,
    },
  };
}

function buildMessageReceiptResult(
  result: { transportMessageId?: string; transportMessageIds?: string[]; conversationId?: string; threadId?: string; downloadUrl?: string },
  input: {
    kind: "text" | "media" | "voice" | "unknown";
    fallbackMessageId: string;
    replyToId?: string | null;
    threadId?: string | number | null;
    sentAt?: number;
  }
) {
  const transportIds = uniqueNonEmptyStrings([
    ...(Array.isArray(result.transportMessageIds) ? result.transportMessageIds : []),
    result.transportMessageId,
  ]);
  const messageIds =
    transportIds.length > 0
      ? transportIds
      : uniqueNonEmptyStrings([result.downloadUrl, result.conversationId, input.fallbackMessageId]);
  const messageId =
    messageIds[0] ?? input.fallbackMessageId;
  const stringThreadId =
    result.threadId ?? (input.threadId !== undefined && input.threadId !== null ? String(input.threadId) : undefined);
  const stringReplyToId =
    input.replyToId !== undefined && input.replyToId !== null ? String(input.replyToId) : undefined;
  return {
    messageId,
    receipt: {
      primaryPlatformMessageId: messageId,
      platformMessageIds: messageIds,
      parts: messageIds.map((platformMessageId, index) => ({
        platformMessageId,
        kind: input.kind,
        index,
        raw: {
          channel: CHANNEL_ID,
          messageId: platformMessageId,
          conversationId: result.conversationId,
          threadId: result.threadId,
          meta: result,
        },
      })),
      ...(stringThreadId ? { threadId: stringThreadId } : {}),
      ...(stringReplyToId ? { replyToId: stringReplyToId } : {}),
      sentAt: input.sentAt ?? Date.now(),
    },
  };
}

function buildRelayOpenclawContext(input: {
  deliveryKindSource: RelayDeliveryKindSource;
  text?: string | null;
  payload?: Record<string, unknown> | null;
  openclawContext?: {
    backendMessageId?: string;
    correlationMessageId?: string;
    runId?: string;
    sessionKey?: string;
    deliveryKind?: "tool" | "block" | "final";
    visibleText?: string;
    mediaSummary?: string;
  };
}) {
  const deliveryKind =
    input.openclawContext?.deliveryKind ??
    inferRelayDeliveryKind({
      source: input.deliveryKindSource,
      text: input.text,
      payload: input.payload,
    });
  return {
    ...input.openclawContext,
    deliveryKind,
    ...buildVisibleDeliverySummary({
      text: input.text,
      payload: input.payload,
    }),
  };
}

function buildVisibleDeliverySummary(input: {
  text?: string | null;
  payload?: Record<string, unknown> | null;
}): { visibleText?: string; mediaSummary?: string } {
  const text = (input.text ?? readPayloadTextForSummary(input.payload)).trim();
  const mediaUrls = readPayloadMediaUrls(input.payload);
  return {
    ...(text ? { visibleText: text } : {}),
    ...(mediaUrls.length > 0 ? { mediaSummary: mediaUrls.length === 1 ? "1 media attachment" : `${mediaUrls.length} media attachments` } : {}),
  };
}

function readPayloadTextForSummary(payload: Record<string, unknown> | null | undefined): string {
  if (!payload) return "";
  const text = payload.text ?? payload.caption;
  return typeof text === "string" ? text : "";
}

function readPayloadMediaUrls(payload: Record<string, unknown> | null | undefined): string[] {
  if (!payload) return [];
  if (typeof payload.mediaUrl === "string" && payload.mediaUrl.trim()) return [payload.mediaUrl.trim()];
  if (Array.isArray(payload.mediaUrls)) {
    return payload.mediaUrls.filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  }
  return [];
}

function isSilentControlReplyText(text: string | null | undefined): boolean {
  const normalized = text?.trim().toUpperCase() ?? "";
  return normalized === "NO_REPLY" || normalized === "NO";
}

function buildSuppressedMessageResult(input: {
  idempotencyKey: string;
  conversationId?: string;
  threadId?: string | number | null;
  replyToId?: string | null;
}) {
  return buildMessageReceiptResult(
    {
      transportMessageId: `relay-message-suppressed:${input.idempotencyKey}`,
      conversationId: input.conversationId,
      threadId:
        input.threadId !== undefined && input.threadId !== null ? String(input.threadId) : undefined,
    },
    {
      kind: "text",
      fallbackMessageId: "relay-message-suppressed",
      replyToId: input.replyToId ?? null,
      threadId: input.threadId ?? null,
    }
  );
}

async function sendRelayMessageThroughSdkAdapter(input: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  to: string;
  text?: string | null;
  mediaUrl?: string | null;
  replyToId?: string | null;
  threadId?: string | number | null;
  audioAsVoice?: boolean;
  forceDocument?: boolean;
  silent?: boolean;
  idempotencyKey?: string | null;
  payload?: Record<string, unknown>;
  deliveryKindSource: RelayDeliveryKindSource;
  openclawContext?: {
    backendMessageId?: string;
    correlationMessageId?: string;
    runId?: string;
    sessionKey?: string;
    deliveryKind?: "tool" | "block" | "final";
    visibleText?: string;
    mediaSummary?: string;
  };
}) {
  const runtime = await ensureRuntimeStarted(input.cfg, input.accountId);
  const { target, explicitThreadId } = resolveOutboundTarget(
    input.to,
    input.threadId ?? null,
    inferImplicitTargetChannel(runtime.getCapabilitySnapshot(), inferTargetChatType(input.to))
  );
  const normalizedPayload = normalizeSdkOutboundPayload({
    text: input.text,
    mediaUrl: input.mediaUrl,
    payload: input.payload,
    audioAsVoice: input.audioAsVoice,
    forceDocument: input.forceDocument,
    silent: input.silent,
  });
  const replyToTransportMessageId = sanitizeReplyToTransportMessageId({
    channel: target.transportTarget.channel,
    replyToId: input.replyToId ?? null,
  });
  const commonPayload = {
    ...(normalizedPayload.audioAsVoice === true ? { asVoice: true } : {}),
    ...(normalizedPayload.forceDocument === true ? { forceDocument: true } : {}),
    ...(normalizedPayload.silent === true ? { silent: true } : {}),
    ...(normalizedPayload.nativeQuote ? { nativeQuote: normalizedPayload.nativeQuote } : {}),
    ...(normalizedPayload.presentation !== undefined ? { presentation: normalizedPayload.presentation } : {}),
    ...(normalizedPayload.interactive !== undefined ? { interactive: normalizedPayload.interactive } : {}),
    ...(normalizedPayload.channelData ? { channelData: normalizedPayload.channelData } : {}),
  };
  const mediaUrls = normalizedPayload.mediaUrls;
  const openclawContext = buildRelayOpenclawContext({
    deliveryKindSource: input.deliveryKindSource,
    text: normalizedPayload.text,
    payload: input.payload ?? null,
    openclawContext: input.openclawContext,
  });
  const idempotencyKey = input.idempotencyKey ?? buildStableSendIdempotencyKey({
    channel: CHANNEL_ID,
    to: input.to,
    accountId: input.accountId ?? null,
    threadId: input.threadId ?? null,
    replyToId: input.replyToId ?? null,
    text: normalizedPayload.text,
    payload: buildRelayMessagePayload({
      text: normalizedPayload.text,
      mediaUrls,
      commonPayload,
    }),
    silent: normalizedPayload.silent,
  });
  if (mediaUrls.length === 0 && isSilentControlReplyText(normalizedPayload.text)) {
    logRuntimeEvent("info", "Suppressing silent control reply", {
      target: summarizeResolvedTarget(target),
      explicitThreadId: explicitThreadId ?? null,
      replyToId: replyToTransportMessageId,
      idempotencyKey,
    });
    return buildSuppressedMessageResult({
      idempotencyKey,
      conversationId: target.conversationHandle ?? target.transportTarget.chatId ?? target.to,
      threadId: explicitThreadId ?? input.threadId ?? null,
      replyToId: replyToTransportMessageId,
    });
  }
  if (mediaUrls.length > 0) {
    const sentAt = Date.now();
    const result = await runtime.sendAction({
      kind: "message.send",
      target,
      payload: buildRelayMessagePayload({
        text: normalizedPayload.text,
        mediaUrls,
        commonPayload,
      }) as any,
      replyToTransportMessageId,
      explicitThreadId,
      idempotencyKey,
      openclawContext,
    });
    return buildMessageReceiptResult(result, {
      kind: normalizedPayload.audioAsVoice ? "voice" : "media",
      fallbackMessageId: "relay-message-media",
      replyToId: replyToTransportMessageId,
      threadId: explicitThreadId ?? input.threadId ?? null,
      sentAt,
    });
  }
  const result = await runtime.sendAction({
    kind: "message.send",
    target,
    payload: {
      ...(normalizedPayload.text ? { text: normalizedPayload.text } : {}),
      ...commonPayload,
    } as any,
    replyToTransportMessageId,
    explicitThreadId,
    idempotencyKey,
    openclawContext,
  });
  return buildMessageReceiptResult(result, {
    kind: "text",
    fallbackMessageId: "relay-message",
    replyToId: replyToTransportMessageId,
    threadId: explicitThreadId ?? input.threadId ?? null,
  });
}

function upsertAccountSection(
  section: RelayChannelSection,
  accountId: string,
  input: { url?: string; port?: number }
): RelayChannelSection {
  const accounts = Array.isArray(section.accounts)
    ? section.accounts.filter((account): account is NonNullable<RelayChannelSection["accounts"]>[number] => {
        return isRecord(account) && typeof account.id === "string" && account.id.trim().length > 0;
      })
    : [];

  const existingIndex = accounts.findIndex((account) => account.id === accountId);
  const nextAccount = {
    ...(existingIndex >= 0 ? accounts[existingIndex] : { id: accountId }),
    ...(input.url ? { url: input.url } : {}),
    ...(typeof input.port === "number" ? { port: input.port } : {}),
  };

  if (existingIndex >= 0) {
    accounts[existingIndex] = nextAccount;
  } else {
    accounts.push(nextAccount);
  }

  return {
    ...section,
    enabled: section.enabled ?? true,
    accounts,
  };
}

const statusRegistry = new RelayStatusRegistry();
const runtimes = new Map<string, RelayAccountRuntime>();
const sendLifecycleRecords = new Map<
  string,
  {
    signature: string;
    status: "started" | "sent" | "failed" | "committed";
    startedAt: number;
    result?: ReturnType<typeof buildMessageReceiptResult>;
    error?: string;
  }
>();

function pruneSendLifecycleRecords(now = Date.now()) {
  const ttlMs = 1000 * 60 * 60;
  for (const [key, record] of sendLifecycleRecords) {
    if (now - record.startedAt > ttlMs) {
      sendLifecycleRecords.delete(key);
    }
  }
}

function buildSendSignature(ctx: Record<string, unknown>): string {
  const payload = isRecord(ctx.payload) ? ctx.payload : {};
  return JSON.stringify({
    channel: ctx.channel ?? CHANNEL_ID,
    to: ctx.to,
    accountId: ctx.accountId ?? null,
    threadId: ctx.threadId ?? null,
    replyToId: ctx.replyToId ?? null,
    text: typeof ctx.text === "string" ? ctx.text : typeof payload.text === "string" ? payload.text : null,
    mediaUrl: typeof ctx.mediaUrl === "string" ? ctx.mediaUrl : null,
    mediaUrls: Array.isArray(payload.mediaUrls) ? payload.mediaUrls : null,
    silent: ctx.silent === true || payload.silent === true,
  });
}

function buildStableSendIdempotencyKey(ctx: Record<string, unknown>): string {
  return `relay-channel:${createHash("sha256").update(buildSendSignature(ctx)).digest("hex")}`;
}

function getRuntime(cfg: OpenClawConfig, accountId?: string | null) {
  const resolvedAccountId = resolvePluginAccountId(cfg, accountId);
  const existing = runtimes.get(resolvedAccountId);
  if (existing) {
    return existing;
  }

  const runtime = new RelayAccountRuntime(
    parseChannelConfig(cfg),
    resolvedAccountId,
    statusRegistry
  );
  runtimes.set(resolvedAccountId, runtime);
  return runtime;
}

async function ensureRuntimeStarted(cfg: OpenClawConfig, accountId?: string | null) {
  const runtime = getRuntime(cfg, accountId);
  if (runtime.getStatus().state === "stopped") {
    await runtime.start();
  }
  return runtime;
}

async function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return;
  }
  await new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

function formatAccountSnapshot(cfg: OpenClawConfig, accountId?: string | null) {
  const resolvedAccountId = resolvePluginAccountId(cfg, accountId);
  const status = statusRegistry.get(resolvedAccountId);
  return {
    accountId: resolvedAccountId,
    enabled: readChannelSection(cfg).enabled !== false,
    configured: Boolean(resolveAccountConfig(parseChannelConfig(cfg), resolvedAccountId).url),
    linked: status.state === "healthy",
    running: status.state !== "stopped",
    connected: status.state === "healthy",
    healthState: status.state,
    recovering: status.recovering,
    reconnectScheduled: status.reconnectScheduled,
    reconnectAttempts: status.reconnectAttempts,
    nextReconnectInMs: status.nextReconnectInMs,
    lastError: status.state === "degraded" ? status.reason : null,
    lastDisconnectReason: status.lastDisconnectReason,
    lastCloseCode: status.lastCloseCode,
    lastCloseReason: status.lastCloseReason,
  };
}

const relayChannelBase = createChannelPluginBase<RelayResolvedAccount>({
  id: CHANNEL_ID,
  meta: {
    id: CHANNEL_ID,
    label: "Relay Channel",
    selectionLabel: "Relay Channel",
    docsPath: "/channels/relay-channel",
    blurb: "Relay-backed OpenClaw channel plugin.",
  },
  capabilities: {
    chatTypes: ["direct", "group", "thread"],
    reply: true,
    threads: true,
    media: true,
  },
  agentPrompt: {
    messageToolHints: () => [
      "- For relay transport, keep `channel` as `relay-channel` when you specify it explicitly.",
      "- Put the recipient into `target`, not into `channel`. Use provider-prefixed relay targets such as `telegram:123456789` or `telegram:group:-100123`.",
    ],
  },
  reload: {
    configPrefixes: [`channels.${CHANNEL_ID}`, `plugins.entries.${CHANNEL_ID}.config`],
  },
  configSchema: buildChannelConfigSchema(relayChannelPluginConfigSchema),
  config: {
    listAccountIds(cfg) {
      try {
        return parseChannelConfig(cfg).accounts.map((account) => account.id);
      } catch {
        return [];
      }
    },
    resolveAccount(cfg, accountId) {
      const parsed = parseChannelConfig(cfg);
      const resolvedAccountId = accountId ?? parsed.accounts[0]?.id ?? "default";
      return {
        ...resolveAccountConfig(parsed, resolvedAccountId),
        accountId: resolvedAccountId,
      };
    },
    inspectAccount(cfg, accountId) {
      const parsed = parseChannelConfig(cfg);
      const resolvedAccountId = accountId ?? parsed.accounts[0]?.id ?? "default";
      const account = parsed.accounts.find((entry) => entry.id === resolvedAccountId);
      return {
        accountId: resolvedAccountId,
        configured: Boolean(account?.url ?? parsed.url ?? account?.port ?? parsed.port),
        enabled: parsed.enabled !== false,
        inspection: inspectRelaySetup(parsed),
      };
    },
    defaultAccountId(cfg) {
      return parseChannelConfig(cfg).accounts[0]?.id ?? "default";
    },
    isEnabled(account, cfg) {
      return Boolean(account.accountId) && readChannelSection(cfg).enabled !== false;
    },
    isConfigured(account) {
      return Boolean(account.url ?? account.port);
    },
  },
  setup: {
    applyAccountConfig({ cfg, accountId, input }) {
      const nextCfg = cloneConfig(cfg);
      const channels = isRecord(nextCfg.channels) ? { ...nextCfg.channels } : {};
      const currentSection = readChannelSection(cfg);
      const url =
        typeof input.url === "string" && input.url.trim().length > 0
          ? input.url.trim()
          : typeof input.httpUrl === "string" && input.httpUrl.trim().length > 0
            ? input.httpUrl.trim()
            : undefined;
      const port =
        typeof input.httpPort === "string" && /^\d+$/.test(input.httpPort)
          ? Number(input.httpPort)
          : undefined;

      channels[CHANNEL_ID] = upsertAccountSection(currentSection, accountId, { url, port });
      nextCfg.channels = channels;
      return nextCfg as OpenClawConfig;
    },
    validateInput() {
      return null;
    },
  },
});

export const relayChannelOpenclawPlugin = {
  ...relayChannelBase,
  status: {
    buildAccountSnapshot({ cfg, account }) {
      return formatAccountSnapshot(cfg, account.accountId);
    },
  },
  gateway: {
    async startAccount({ cfg, accountId, account, abortSignal }) {
      await ensureRuntimeStarted(cfg, accountId ?? account?.accountId ?? null);
      await waitForAbort(abortSignal);
    },
    async stopAccount({ cfg, accountId, account }) {
      const runtime = getRuntime(cfg, accountId ?? account?.accountId ?? null);
      await runtime.stop();
    },
  },
  messaging: {
    normalizeTarget,
    parseExplicitTarget({ raw }) {
      const parsed = parseExplicitTarget(raw);
      if (!parsed) {
        return null;
      }
      return {
        to: parsed.scope
          ? `${parsed.channel}:${parsed.scope}:${parsed.conversationId}`
          : `${parsed.channel}:${parsed.conversationId}`,
        threadId: parsed.threadId ?? undefined,
        chatType: mapRelayScopeToChatType(parsed.scope),
      };
    },
    inferTargetChatType({ to }) {
      return mapRelayScopeToChatType(inferTargetChatType(to));
    },
    formatTargetDisplay({ target, display }) {
      const trimmedDisplay = display?.trim();
      if (trimmedDisplay) {
        return trimmedDisplay;
      }
      return formatResolvedTargetDisplay(resolveTarget(target));
    },
    resolveOutboundSessionRoute({ agentId, target, replyToId, threadId }) {
      const resolvedTarget = resolveTarget(target);
      const route = resolveOutboundSessionRoute({
        resolvedTarget: {
          ...resolvedTarget,
          threadId:
            threadId !== undefined && threadId !== null
              ? String(threadId)
              : resolvedTarget.threadId ?? null,
        },
        replyToTransportMessageId: replyToId ?? null,
        explicitThreadId:
          threadId !== undefined && threadId !== null ? String(threadId) : null,
      });
      return {
        sessionKey: route.conversationId,
        baseSessionKey: route.baseConversationId,
        peer: {
          kind: mapRelayScopeToChatType(resolvedTarget.kind),
          id: route.baseConversationId,
        },
        chatType: mapRelayScopeToChatType(resolvedTarget.kind),
        from: agentId,
        to: route.conversationId,
        ...(route.threadId ? { threadId: route.threadId } : {}),
      };
    },
    targetResolver: {
      looksLikeId(raw, normalized) {
        return parseExplicitTarget(normalized ?? raw) !== null || Boolean(normalizeTarget(raw));
      },
      hint:
        "Set channel to relay-channel and pass the recipient through target as an explicit provider target like telegram:<chatId> or telegram:group:<chatId>.",
      async resolveTarget({ cfg, accountId, input }) {
        const runtime = getRuntime(cfg, accountId);
        const resolved = resolveTarget(input, {
          defaultChannel: inferImplicitTargetChannel(
            runtime.getCapabilitySnapshot(),
            inferTargetChatType(input)
          ),
        });
        return {
          to: resolved.to,
          kind: mapRelayScopeToDirectoryKind(resolved.kind),
          display: resolved.display,
          source: "normalized" as const,
        };
      },
    },
  },
  resolver: {
    async resolveTargets({ inputs }) {
      return inputs.map((input) => {
        const resolved = resolveTarget(input);
        return {
          input,
          resolved: true,
          id: resolved.to,
          name: resolved.display,
          note: "normalized explicit relay target",
        };
      });
    },
  },
  actions: {
    describeMessageTool({ cfg, accountId }) {
      const runtime = getRuntime(cfg, accountId);
      const snapshot = runtime.getCapabilitySnapshot();
      const discovery = describeMessageTool(snapshot);
      const actionAllowlist = new Set(["send", "typing"]);
      logRuntimeEvent("info", "describeMessageTool resolved", {
        accountId: resolvePluginAccountId(cfg, accountId),
        transportProvider: snapshot?.transport.provider ?? null,
        actions: discovery.actions.filter((action) => actionAllowlist.has(action)),
        capabilities: Array.isArray(discovery.capabilities) ? discovery.capabilities : [],
        schemaProperties: Array.isArray(discovery.schema)
          ? discovery.schema.flatMap((entry) => {
              if (!isRecord(entry) || !isRecord(entry.properties)) {
                return [];
              }
              return Object.keys(entry.properties);
            })
          : [],
      });
      return {
        actions: discovery.actions.filter((action) => actionAllowlist.has(action)),
        ...(Array.isArray(discovery.capabilities) && discovery.capabilities.length > 0
          ? { capabilities: discovery.capabilities }
          : {}),
        ...(Array.isArray(discovery.schema) && discovery.schema.length > 0
          ? { schema: discovery.schema }
          : {}),
      };
    },
    prepareSendPayload({ payload }) {
      return payload;
    },
    supportsAction({ action }) {
      return ["send", "typing"].includes(String(action));
    },
    async handleAction({ action, params, cfg, accountId, toolContext }) {
      const requestedAction = String(action);
      const runtime = await ensureRuntimeStarted(cfg, accountId);
      const rawTargetForScope =
        readStringParam(params, "to") ??
        readStringParam(params, "target") ??
        readStringParam(params, "channelId") ??
        readStringParam(params, "targetId");
      const { target, explicitThreadId } = readMessageActionTarget({
        rawParams: params,
        toolContext,
        defaultChannel: inferImplicitTargetChannel(
          runtime.getCapabilitySnapshot(),
          rawTargetForScope ? inferTargetChatType(rawTargetForScope) : undefined
        ),
      });
      const rawReplyToId = readStringParam(params, "replyTo");
      const replyToTransportMessageId = sanitizeReplyToTransportMessageId({
        channel: target.transportTarget.channel,
        replyToId: rawReplyToId ?? null,
      });
      const sessionRoute = resolveOutboundSessionRoute({
        resolvedTarget: target,
        replyToTransportMessageId,
        explicitThreadId,
      });
      logRuntimeEvent("info", "handleAction dispatch", {
        accountId: resolvePluginAccountId(cfg, accountId),
        action: requestedAction,
        target: summarizeResolvedTarget(target),
        explicitThreadId: explicitThreadId ?? null,
        params: summarizeMessageActionParams(params),
      });

      if (requestedAction === "send") {
        const text =
          readStringParam(params, "message") ??
          readStringParam(params, "content") ??
          "";
        const mediaUrls = collectMessageActionMediaUrls(params);
        const forceDocument =
          readBooleanParam(params, "forceDocument") === true ||
          readBooleanParam(params, "asDocument") === true;
        const asVoice = readBooleanParam(params, "asVoice") === true;
        const silent = readBooleanParam(params, "silent") === true;
        const replyToId = replyToTransportMessageId;
        const commonPayload = {
          ...(asVoice ? { asVoice: true } : {}),
          ...(forceDocument ? { forceDocument: true } : {}),
          ...(silent ? { silent: true } : {}),
        };
        logRuntimeEvent("info", "handleAction send resolved", {
          accountId: resolvePluginAccountId(cfg, accountId),
          target: summarizeResolvedTarget(target),
          explicitThreadId: explicitThreadId ?? null,
          replyToId: replyToId ?? null,
          forceDocument,
          payload: summarizeOutboundPayload({
            payload: params,
            text,
          }),
        });
        const idempotencyKey =
          readStringParam(params, "idempotencyKey") ??
          readStringParam(params, "attemptToken") ??
          buildStableSendIdempotencyKey({
            channel: CHANNEL_ID,
            to: target.to,
            accountId: accountId ?? null,
            threadId: explicitThreadId ?? null,
            replyToId: replyToId ?? null,
            text,
            payload: buildRelayMessagePayload({
              text,
              mediaUrls,
              commonPayload,
            }),
            silent,
          });
        if (mediaUrls.length === 0 && isSilentControlReplyText(text)) {
          logRuntimeEvent("info", "Suppressing silent control reply", {
            accountId: resolvePluginAccountId(cfg, accountId),
            target: summarizeResolvedTarget(target),
            explicitThreadId: explicitThreadId ?? null,
            replyToId: replyToId ?? null,
            idempotencyKey,
          });
          const suppressed = buildSuppressedMessageResult({
            idempotencyKey,
            conversationId: sessionRoute.conversationId,
            threadId: explicitThreadId ?? null,
            replyToId,
          });
          return jsonResult({
            ok: true,
            messageId: suppressed.messageId,
            conversationId: sessionRoute.conversationId,
          });
        }
        const result = await runtime.sendAction({
          kind: "message.send",
          target,
          payload: buildRelayMessagePayload({
            text,
            mediaUrls,
            commonPayload,
          }) as any,
          replyToTransportMessageId: replyToId ?? null,
          explicitThreadId,
          sessionKey: sessionRoute.conversationId,
          idempotencyKey,
          openclawContext: buildRelayOpenclawContext({
            deliveryKindSource: "message-adapter",
            text,
            openclawContext: { sessionKey: sessionRoute.conversationId },
          }),
        });
        return jsonResult({
          ok: true,
          messageId: result.transportMessageId ?? "",
          ...(Array.isArray(result.transportMessageIds) ? { messageIds: result.transportMessageIds } : {}),
          conversationId: result.conversationId,
        });
      }

      if (requestedAction === "typing") {
        const result = await runtime.sendAction({
          kind: "typing.set",
          target,
          payload: {
            ...(readBooleanParam(params, "enabled") !== undefined
              ? { enabled: readBooleanParam(params, "enabled") === true }
              : {}),
            ...(readStringParam(params, "chatAction") ? { chatAction: readStringParam(params, "chatAction") } : {}),
          },
          explicitThreadId,
          sessionKey: sessionRoute.conversationId,
        });
        return jsonResult({
          ok: true,
          messageId: result.transportMessageId ?? "",
          conversationId: result.conversationId,
        });
      }

      throw new Error(`Unsupported relay-channel action: ${requestedAction}`);
    },
  },
  message: {
    id: CHANNEL_ID,
    durableFinal: {
      capabilities: {
        text: true,
        media: true,
        payload: true,
        silent: true,
        replyTo: true,
        thread: true,
        nativeQuote: true,
        batch: true,
        reconcileUnknownSend: true,
        messageSendingHooks: true,
        afterSendSuccess: true,
        afterCommit: true,
      },
      async reconcileUnknownSend(ctx) {
        pruneSendLifecycleRecords();
        const signature = buildSendSignature(ctx);
        const matched = Array.from(sendLifecycleRecords.values())
          .filter((record) => record.signature === signature)
          .sort((a, b) => b.startedAt - a.startedAt)[0];
        if (matched?.status === "sent" || matched?.status === "committed") {
          return matched.result
            ? { status: "sent", receipt: matched.result.receipt, messageId: matched.result.messageId }
            : { status: "unresolved", retryable: true, error: "send record has no receipt" };
        }
        if (!ctx.platformSendStartedAt) {
          return { status: "not_sent" };
        }
        const cfg = isRecord(ctx.cfg) ? (ctx.cfg as OpenClawConfig) : undefined;
        if (cfg) {
          try {
            const runtime = await ensureRuntimeStarted(
              cfg,
              typeof ctx.accountId === "string" ? ctx.accountId : undefined
            );
            const idempotencyKey =
              typeof ctx.idempotencyKey === "string" && ctx.idempotencyKey.trim()
                ? ctx.idempotencyKey
                : typeof ctx.attemptToken === "string" && ctx.attemptToken.trim()
                  ? ctx.attemptToken
                  : buildStableSendIdempotencyKey(ctx);
            const reconciled = await runtime.reconcileAction({
              provider: "telegram",
              idempotencyKey,
            });
            if (reconciled.status === "sent") {
              const payload = isRecord(ctx.payload) ? ctx.payload : {};
              const result = buildMessageReceiptResult(reconciled.receipt, {
                kind:
                  Array.isArray(payload.mediaUrls) || typeof payload.mediaUrl === "string"
                    ? "media"
                    : "text",
                fallbackMessageId: "relay-message",
                replyToId: typeof ctx.replyToId === "string" ? ctx.replyToId : null,
                threadId:
                  typeof ctx.threadId === "string" || typeof ctx.threadId === "number"
                    ? ctx.threadId
                    : null,
              });
              return { status: "sent", receipt: result.receipt, messageId: result.messageId };
            }
            return reconciled;
          } catch (error) {
            return {
              status: "unresolved",
              retryable: true,
              error: error instanceof Error ? error.message : String(error),
            };
          }
        }
        return {
          status: "unresolved",
          retryable: true,
          error: matched?.error ?? "relay-channel send state is not durably recoverable",
        };
      },
    },
    live: {
      capabilities: {
        previewFinalization: true,
      },
      finalizer: {
        capabilities: {
          normalFallback: true,
        },
      },
    },
    receive: {
      defaultAckPolicy: "manual",
      supportedAckPolicies: ["manual"],
    },
    send: {
      text: async ({ cfg, to, text, accountId, replyToId, threadId, silent, idempotencyKey, attemptToken }: any) =>
        await sendRelayMessageThroughSdkAdapter({
          cfg,
          accountId,
          to,
          text,
          replyToId,
          threadId,
          silent,
          idempotencyKey: typeof idempotencyKey === "string" ? idempotencyKey : typeof attemptToken === "string" ? attemptToken : undefined,
          deliveryKindSource: "message-adapter",
        }),
      media: async ({ cfg, to, text, mediaUrl, accountId, replyToId, threadId, audioAsVoice, forceDocument, silent, idempotencyKey, attemptToken }: any) =>
        await sendRelayMessageThroughSdkAdapter({
          cfg,
          accountId,
          to,
          text,
          mediaUrl,
          replyToId,
          threadId,
          audioAsVoice,
          forceDocument,
          silent,
          idempotencyKey: typeof idempotencyKey === "string" ? idempotencyKey : typeof attemptToken === "string" ? attemptToken : undefined,
          deliveryKindSource: "message-adapter",
        }),
      payload: async ({ cfg, to, text, mediaUrl, payload, accountId, replyToId, threadId, audioAsVoice, forceDocument, silent, idempotencyKey, attemptToken }: any) =>
        await sendRelayMessageThroughSdkAdapter({
          cfg,
          accountId,
          to,
          text: typeof payload.text === "string" ? payload.text : text,
          mediaUrl,
          payload,
          replyToId,
          threadId,
          audioAsVoice: audioAsVoice ?? payload.audioAsVoice === true,
          forceDocument,
          silent,
          idempotencyKey: typeof idempotencyKey === "string" ? idempotencyKey : typeof attemptToken === "string" ? attemptToken : undefined,
          deliveryKindSource: "message-adapter",
        }),
      lifecycle: {
        beforeSendAttempt(ctx: Record<string, unknown>) {
          pruneSendLifecycleRecords();
          const token =
            typeof ctx.idempotencyKey === "string" && ctx.idempotencyKey.trim()
              ? ctx.idempotencyKey
              : buildStableSendIdempotencyKey(ctx);
          sendLifecycleRecords.set(token, {
            signature: buildSendSignature(ctx),
            status: "started",
            startedAt: Date.now(),
          });
          logRuntimeEvent("info", "relay-channel SDK send attempt started", {
            token,
            kind: ctx.kind,
            to: ctx.to,
          });
          return token;
        },
        afterSendSuccess(ctx: Record<string, unknown>) {
          const token = typeof ctx.attemptToken === "string" ? ctx.attemptToken : null;
          if (!token) {
            return;
          }
          const existing = sendLifecycleRecords.get(token);
          if (!existing) {
            return;
          }
          sendLifecycleRecords.set(token, {
            ...existing,
            status: "sent",
            result: isRecord(ctx.result) ? (ctx.result as any) : undefined,
          });
        },
        afterSendFailure(ctx: Record<string, unknown>) {
          const token = typeof ctx.attemptToken === "string" ? ctx.attemptToken : null;
          if (!token) {
            return;
          }
          const existing = sendLifecycleRecords.get(token);
          if (!existing) {
            return;
          }
          sendLifecycleRecords.set(token, {
            ...existing,
            status: "failed",
            error: ctx.error instanceof Error ? ctx.error.message : String(ctx.error ?? "unknown error"),
          });
        },
        afterCommit(ctx: Record<string, unknown>) {
          const token = typeof ctx.attemptToken === "string" ? ctx.attemptToken : null;
          if (!token) {
            return;
          }
          const existing = sendLifecycleRecords.get(token);
          if (!existing) {
            return;
          }
          sendLifecycleRecords.set(token, {
            ...existing,
            status: "committed",
          });
        },
      },
    },
  },
  outbound: {
    deliveryMode: "direct" as const,
    normalizePayload: normalizeRelayOutboundPayload,
    sendPayload: async (input: any) => {
      const { cfg, to, payload, accountId, replyToId, threadId, forceDocument } = input;
      const text = typeof payload?.text === "string" ? payload.text : "";
      logRuntimeEvent("info", "sendPayload resolved", {
        accountId: resolvePluginAccountId(cfg, accountId),
        target: to,
        explicitThreadId: threadId ?? null,
        replyToId: replyToId ?? null,
        forceDocument: forceDocument === true,
        payload: summarizeOutboundPayload({
          payload,
          text,
        }),
      });
      const result = await sendRelayMessageThroughSdkAdapter({
        cfg,
        accountId,
        to,
        text,
        payload,
        replyToId,
        threadId,
        audioAsVoice: payload?.audioAsVoice === true,
        forceDocument: forceDocument === true || payload?.forceDocument === true,
        silent: payload?.silent === true,
        deliveryKindSource: "outbound",
      });
      return {
        channel: CHANNEL_ID,
        messageId: result.messageId,
        meta: result,
      };
    },
    sendText: async ({ cfg, to, text, accountId, replyToId, threadId }) => {
      const runtime = await ensureRuntimeStarted(cfg, accountId);
      const { target, explicitThreadId } = resolveOutboundTarget(
        to,
        threadId ?? null,
        inferImplicitTargetChannel(runtime.getCapabilitySnapshot(), inferTargetChatType(to))
      );
      const result = await runtime.sendAction({
        kind: "message.send",
        target,
        payload: { text },
        replyToTransportMessageId: replyToId ?? null,
        explicitThreadId,
        openclawContext: buildRelayOpenclawContext({
          deliveryKindSource: "outbound",
          text,
        }),
      });
      return buildOpenClawOutboundResult(result, "relay-message");
    },
    sendMedia: async (input: any) => {
      const { cfg, to, text, mediaUrl, accountId, replyToId, threadId, forceDocument } = input;
      const asVoice = input.asVoice === true;
      const runtime = await ensureRuntimeStarted(cfg, accountId);
      const { target, explicitThreadId } = resolveOutboundTarget(
        to,
        threadId ?? null,
        inferImplicitTargetChannel(runtime.getCapabilitySnapshot(), inferTargetChatType(to))
      );
      if (typeof mediaUrl !== "string" || mediaUrl.trim().length === 0) {
        throw new Error("MEDIA_URL_REQUIRED: relay-channel sendMedia requires mediaUrl");
      }
      const payload = {
        ...(text ? { text } : {}),
        mediaUrl,
        ...(asVoice === true ? { asVoice: true } : {}),
        ...(forceDocument === true ? { forceDocument: true } : {}),
      };
      const result = await runtime.sendAction({
        kind: "message.send",
        target,
        payload,
        replyToTransportMessageId: replyToId ?? null,
        explicitThreadId,
        openclawContext: buildRelayOpenclawContext({
          deliveryKindSource: "outbound",
          text,
          payload,
        }),
      });
      return buildOpenClawOutboundResult(result, "relay-message");
    },
    requestFileDownload: async (input: any) => {
      const { cfg, to, accountId, fileId } = input;
      const runtime = await ensureRuntimeStarted(cfg, accountId);
      const resolvedTarget = resolveTarget(to, {
        defaultChannel: inferImplicitTargetChannel(
          runtime.getCapabilitySnapshot(),
          inferTargetChatType(to)
        ),
      });
      const result = await runtime.sendAction({
        kind: "file.download.request",
        target: resolvedTarget,
        payload: { fileId },
      });
      return buildOpenClawOutboundResult(result, "relay-download");
    },
  },
} as ChannelPlugin<RelayResolvedAccount>;
