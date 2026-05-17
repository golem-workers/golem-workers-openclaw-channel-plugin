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
  return {
    textLength: text.length,
    hasMediaUrl: typeof payload?.mediaUrl === "string" && payload.mediaUrl.trim().length > 0,
  };
}

function summarizeMessageActionParams(params: Record<string, unknown>) {
  return {
    hasTarget: typeof params.target === "string" && params.target.trim().length > 0,
    hasTo: typeof params.to === "string" && params.to.trim().length > 0,
    hasMessage:
      typeof params.message === "string" || typeof params.content === "string",
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

function buildMessageReceiptResult(
  result: { transportMessageId?: string; conversationId?: string; threadId?: string; downloadUrl?: string },
  input: {
    kind: "text" | "media";
    fallbackMessageId: string;
    replyToId?: string | null;
    threadId?: string | number | null;
  }
) {
  const messageId =
    result.transportMessageId ??
    result.conversationId ??
    result.downloadUrl ??
    input.fallbackMessageId;
  const stringThreadId =
    result.threadId ?? (input.threadId !== undefined && input.threadId !== null ? String(input.threadId) : undefined);
  const stringReplyToId =
    input.replyToId !== undefined && input.replyToId !== null ? String(input.replyToId) : undefined;
  return {
    messageId,
    receipt: {
      primaryPlatformMessageId: messageId,
      platformMessageIds: [messageId],
      parts: [
        {
          platformMessageId: messageId,
          kind: input.kind,
          index: 0,
          raw: {
            channel: CHANNEL_ID,
            messageId,
            conversationId: result.conversationId,
            threadId: result.threadId,
            meta: result,
          },
        },
      ],
      ...(stringThreadId ? { threadId: stringThreadId } : {}),
      ...(stringReplyToId ? { replyToId: stringReplyToId } : {}),
      sentAt: Date.now(),
    },
  };
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
}) {
  const runtime = await ensureRuntimeStarted(input.cfg, input.accountId);
  const { target, explicitThreadId } = resolveOutboundTarget(
    input.to,
    input.threadId ?? null,
    inferImplicitTargetChannel(runtime.getCapabilitySnapshot(), inferTargetChatType(input.to))
  );
  const text = input.text?.trim() ?? "";
  const parsedTextAttachments = input.mediaUrl ? { text, mediaUrls: [] } : extractTextAttachmentMedia(text);
  const textForSend = parsedTextAttachments.text;
  const mediaUrl = input.mediaUrl?.trim() ?? parsedTextAttachments.mediaUrls[0] ?? "";
  const replyToTransportMessageId = sanitizeReplyToTransportMessageId({
    channel: target.transportTarget.channel,
    replyToId: input.replyToId ?? null,
  });
  const result = await runtime.sendAction({
    kind: "message.send",
    target,
    payload: {
      ...(textForSend ? { text: textForSend } : {}),
      ...(mediaUrl ? { mediaUrl } : {}),
      ...(input.audioAsVoice === true ? { asVoice: true } : {}),
      ...(input.forceDocument === true ? { forceDocument: true } : {}),
    },
    replyToTransportMessageId,
    explicitThreadId,
  });
  return buildMessageReceiptResult(result, {
    kind: mediaUrl ? "media" : "text",
    fallbackMessageId: "relay-message",
    replyToId: replyToTransportMessageId,
    threadId: explicitThreadId ?? input.threadId ?? null,
  });
}

function firstPayloadMediaUrl(payload: Record<string, unknown>, fallback?: string): string | undefined {
  if (typeof fallback === "string" && fallback.trim()) {
    return fallback;
  }
  const mediaUrl = payload.mediaUrl;
  if (typeof mediaUrl === "string" && mediaUrl.trim()) {
    return mediaUrl;
  }
  const mediaUrls = payload.mediaUrls;
  if (Array.isArray(mediaUrls)) {
    const first = mediaUrls.find((item): item is string => typeof item === "string" && item.trim().length > 0);
    return first;
  }
  return undefined;
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
        const mediaUrl =
          readStringParam(params, "media", { trim: false }) ??
          readStringParam(params, "mediaUrl", { trim: false }) ??
          readStringParam(params, "path", { trim: false }) ??
          readStringParam(params, "filePath", { trim: false }) ??
          readStringParam(params, "fileUrl", { trim: false }) ??
          undefined;
        const forceDocument =
          readBooleanParam(params, "forceDocument") === true ||
          readBooleanParam(params, "asDocument") === true;
        const asVoice = readBooleanParam(params, "asVoice") === true;
        const replyToId = readStringParam(params, "replyTo");
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
        const result = await runtime.sendAction({
          kind: "message.send",
          target,
          payload: {
            ...(text ? { text } : {}),
            ...(mediaUrl ? { mediaUrl } : {}),
            ...(asVoice ? { asVoice: true } : {}),
            ...(forceDocument ? { forceDocument: true } : {}),
          },
          replyToTransportMessageId: replyToId ?? null,
          explicitThreadId,
        });
        return jsonResult({
          ok: true,
          messageId: result.transportMessageId ?? "",
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
        replyTo: true,
        thread: true,
      },
    },
    receive: {
      defaultAckPolicy: "manual",
      supportedAckPolicies: ["manual"],
    },
    send: {
      text: async ({ cfg, to, text, accountId, replyToId, threadId }) =>
        await sendRelayMessageThroughSdkAdapter({
          cfg,
          accountId,
          to,
          text,
          replyToId,
          threadId,
        }),
      media: async ({ cfg, to, text, mediaUrl, accountId, replyToId, threadId, audioAsVoice, forceDocument }) =>
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
        }),
      payload: async ({ cfg, to, text, mediaUrl, payload, accountId, replyToId, threadId, audioAsVoice, forceDocument }) =>
        await sendRelayMessageThroughSdkAdapter({
          cfg,
          accountId,
          to,
          text: typeof payload.text === "string" ? payload.text : text,
          mediaUrl: firstPayloadMediaUrl(payload, mediaUrl),
          replyToId,
          threadId,
          audioAsVoice: audioAsVoice ?? payload.audioAsVoice === true,
          forceDocument,
        }),
    },
  },
  outbound: {
    deliveryMode: "direct" as const,
    sendPayload: async (input: any) => {
      const { cfg, to, payload, accountId, replyToId, threadId, forceDocument } = input;
      const runtime = await ensureRuntimeStarted(cfg, accountId);
      const { target, explicitThreadId } = resolveOutboundTarget(
        to,
        threadId ?? null,
        inferImplicitTargetChannel(runtime.getCapabilitySnapshot(), inferTargetChatType(to))
      );
      const text = typeof payload?.text === "string" ? payload.text : "";
      logRuntimeEvent("info", "sendPayload resolved", {
        accountId: resolvePluginAccountId(cfg, accountId),
        target: summarizeResolvedTarget(target),
        explicitThreadId: explicitThreadId ?? null,
        replyToId: replyToId ?? null,
        forceDocument: forceDocument === true,
        payload: summarizeOutboundPayload({
          payload,
          text,
        }),
      });
      const result = await runtime.sendAction({
        kind: "message.send",
        target,
        payload: {
          ...(text ? { text } : {}),
          ...(typeof payload?.mediaUrl === "string" && payload.mediaUrl.trim().length > 0
            ? { mediaUrl: payload.mediaUrl }
            : {}),
          ...(payload?.audioAsVoice === true ? { asVoice: true } : {}),
          ...(forceDocument === true ? { forceDocument: true } : {}),
        },
        replyToTransportMessageId: replyToId ?? null,
        explicitThreadId,
      });
      return buildOpenClawOutboundResult(result, "relay-message");
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
      const result = await runtime.sendAction({
        kind: "message.send",
        target,
        payload: {
          ...(text ? { text } : {}),
          mediaUrl,
          ...(asVoice === true ? { asVoice: true } : {}),
          ...(forceDocument === true ? { forceDocument: true } : {}),
        },
        replyToTransportMessageId: replyToId ?? null,
        explicitThreadId,
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
