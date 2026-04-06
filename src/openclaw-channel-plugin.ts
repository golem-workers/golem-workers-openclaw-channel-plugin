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

function inferImplicitTargetChannel(capabilities: RelayCapabilitySnapshot | undefined): string | null {
  const providers = new Set<string>();
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
    addProvider(profile.transport.provider);
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
          defaultChannel: inferImplicitTargetChannel(runtime.getCapabilitySnapshot()),
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
    supportsAction({ action }) {
      return ["send", "typing"].includes(String(action));
    },
    async handleAction({ action, params, cfg, accountId, toolContext }) {
      const requestedAction = String(action);
      const runtime = await ensureRuntimeStarted(cfg, accountId);
      const { target, explicitThreadId } = readMessageActionTarget({
        rawParams: params,
        toolContext,
        defaultChannel: inferImplicitTargetChannel(runtime.getCapabilitySnapshot()),
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
  outbound: {
    deliveryMode: "direct" as const,
    sendPayload: async (input: any) => {
      const { cfg, to, payload, accountId, replyToId, threadId, forceDocument } = input;
      const runtime = await ensureRuntimeStarted(cfg, accountId);
      const { target, explicitThreadId } = resolveOutboundTarget(
        to,
        threadId ?? null,
        inferImplicitTargetChannel(runtime.getCapabilitySnapshot())
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
        inferImplicitTargetChannel(runtime.getCapabilitySnapshot())
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
        inferImplicitTargetChannel(runtime.getCapabilitySnapshot())
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
        defaultChannel: inferImplicitTargetChannel(runtime.getCapabilitySnapshot()),
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
