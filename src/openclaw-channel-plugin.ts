import {
  buildChannelConfigSchema,
  createChannelPluginBase,
  type ChannelPlugin,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/core";
import { readBooleanParam } from "openclaw/plugin-sdk/boolean-param";
import { resolveInteractiveTextFallback } from "openclaw/plugin-sdk/interactive-runtime";
import {
  jsonResult,
  readReactionParams,
  readStringArrayParam,
  readStringOrNumberParam,
  readStringParam,
} from "openclaw/plugin-sdk/telegram-core";
import { RelayAccountRuntime } from "./account-runtime.js";
import { parseRelayChannelPluginConfig, relayChannelPluginConfigSchema, resolveAccountConfig } from "./config.js";
import { describeMessageTool } from "./message-actions.js";
import { resolveOutboundSessionRoute } from "./outbound-session-route.js";
import { inspectRelaySetup } from "./setup.js";
import { RelayStatusRegistry } from "./status.js";
import {
  formatTargetDisplay as formatResolvedTargetDisplay,
  inferTargetChatType,
  normalizeTarget,
  parseExplicitTarget,
  resolveTarget,
} from "./target-resolution.js";

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

function buildReplyMarkup(
  buttons:
    | ReadonlyArray<ReadonlyArray<{ text: string; callback_data: string }>>
    | undefined
) {
  if (!buttons?.length) {
    return undefined;
  }
  const inlineKeyboard = buttons
    .map((row) =>
      row
        .filter(
          (button) =>
            typeof button?.text === "string" &&
            button.text.trim().length > 0 &&
            typeof button?.callback_data === "string" &&
            button.callback_data.trim().length > 0
        )
        .map((button) => ({
          text: button.text,
          callback_data: button.callback_data,
        }))
    )
    .filter((row) => row.length > 0);
  return inlineKeyboard.length > 0 ? { inline_keyboard: inlineKeyboard } : undefined;
}

function readTelegramInlineButtons(
  rawButtons: unknown,
  interactive: unknown
): ReadonlyArray<ReadonlyArray<{ text: string; callback_data: string }>> | undefined {
  if (Array.isArray(rawButtons)) {
    const normalizedRows = rawButtons
      .map((row) => {
        if (!Array.isArray(row)) {
          return [];
        }
        return row
          .map((button) => {
            if (!isRecord(button)) {
              return null;
            }
            const text = typeof button.text === "string" ? button.text.trim() : "";
            const callbackData =
              typeof button.callback_data === "string"
                ? button.callback_data.trim()
                : typeof button.callbackData === "string"
                  ? button.callbackData.trim()
                  : "";
            return text && callbackData ? { text, callback_data: callbackData } : null;
          })
          .filter((button): button is { text: string; callback_data: string } => button !== null);
      })
      .filter((row) => row.length > 0);
    if (normalizedRows.length > 0) {
      return normalizedRows;
    }
  }

  if (!isRecord(interactive) || !Array.isArray(interactive.blocks)) {
    return undefined;
  }
  const rows: Array<Array<{ text: string; callback_data: string }>> = [];
  for (const block of interactive.blocks) {
    if (!isRecord(block)) {
      continue;
    }
    if (block.type === "buttons" && Array.isArray(block.buttons)) {
      for (let index = 0; index < block.buttons.length; index += 3) {
        const row = block.buttons
          .slice(index, index + 3)
          .map((button) => {
            if (!isRecord(button)) {
              return null;
            }
            const label = typeof button.label === "string" ? button.label.trim() : "";
            const value =
              typeof button.value === "string"
                ? button.value.trim()
                : typeof button.text === "string"
                  ? button.text.trim()
                  : "";
            return label && value ? { text: label, callback_data: value } : null;
          })
          .filter((button): button is { text: string; callback_data: string } => button !== null);
        if (row.length > 0) {
          rows.push(row);
        }
      }
      continue;
    }
    if (block.type === "select" && Array.isArray(block.options)) {
      for (let index = 0; index < block.options.length; index += 3) {
        const row = block.options
          .slice(index, index + 3)
          .map((option) => {
            if (!isRecord(option)) {
              return null;
            }
            const label = typeof option.label === "string" ? option.label.trim() : "";
            const value = typeof option.value === "string" ? option.value.trim() : "";
            return label && value ? { text: label, callback_data: value } : null;
          })
          .filter((button): button is { text: string; callback_data: string } => button !== null);
        if (row.length > 0) {
          rows.push(row);
        }
      }
    }
  }
  return rows.length > 0 ? rows : undefined;
}

function resolveOutboundTarget(to: string, threadId?: string | number | null) {
  const resolvedTarget = resolveTarget(to);
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
  return resolveOutboundTarget(to, threadId ?? null);
}

function readActionTransportMessageId(params: {
  rawParams: Record<string, unknown>;
  fallbackMessageId?: string | number;
  required?: boolean;
}) {
  const messageId =
    readStringOrNumberParam(params.rawParams, "transportMessageId") ??
    readStringOrNumberParam(params.rawParams, "messageId") ??
    readStringOrNumberParam(params.rawParams, "targetTransportMessageId") ??
    params.fallbackMessageId;
  if (messageId === undefined || messageId === null || String(messageId).trim().length === 0) {
    if (params.required === false) {
      return undefined;
    }
    throw new Error("messageId is required.");
  }
  return String(messageId);
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
    lastError: status.state === "degraded" ? status.reason : null,
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
        return parseExplicitTarget(normalized ?? raw) !== null;
      },
      hint: "Use explicit relay target like telegram:<conversationHandle> or telegram:group:<chatId>",
      async resolveTarget({ input }) {
        const resolved = resolveTarget(input);
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
      const actionAllowlist = new Set(["send", "poll", "react", "edit", "delete", "pin"]);
      const capabilities = new Set<string>();
      if (
        snapshot?.optionalCapabilities["telegram.inlineButtons"] ||
        snapshot?.providerCapabilities["telegram.inlineButtons"]
      ) {
        capabilities.add("interactive");
        capabilities.add("buttons");
      }
      return {
        actions: discovery.actions.filter((action) => actionAllowlist.has(action)),
        capabilities: Array.from(capabilities),
      };
    },
    supportsAction({ action }) {
      return ["poll", "react", "edit", "delete", "pin", "unpin"].includes(action);
    },
    async handleAction({ action, params, cfg, accountId, toolContext }) {
      const runtime = await ensureRuntimeStarted(cfg, accountId);
      const { target, explicitThreadId } = readMessageActionTarget({
        rawParams: params,
        toolContext,
      });

      if (action === "poll") {
        const question =
          readStringParam(params, "question") ??
          readStringParam(params, "pollQuestion", { required: true });
        const options =
          readStringArrayParam(params, "answers") ??
          readStringArrayParam(params, "pollOption", { required: true });
        const result = await runtime.sendAction({
          kind: "poll.send",
          target,
          payload: {
            question,
            options,
            ...(readBooleanParam(params, "allowMultiselect") === true ||
            readBooleanParam(params, "pollMulti") === true
              ? { allowsMultipleAnswers: true }
              : {}),
            ...(readBooleanParam(params, "isAnonymous") !== undefined
              ? { isAnonymous: readBooleanParam(params, "isAnonymous") === true }
              : readBooleanParam(params, "pollAnonymous") !== undefined
                ? { isAnonymous: readBooleanParam(params, "pollAnonymous") === true }
                : {}),
          },
          explicitThreadId,
        });
        return jsonResult({
          ok: true,
          messageId: result.transportMessageId ?? "",
          conversationId: result.conversationId,
        });
      }

      if (action === "edit") {
        const transportMessageId = readActionTransportMessageId({
          rawParams: params,
          required: true,
        })!;
        const result = await runtime.sendAction({
          kind: "message.edit",
          target,
          payload: {
            transportMessageId,
            text:
              readStringParam(params, "message") ??
              readStringParam(params, "content", { required: true }),
          },
          explicitThreadId,
        });
        return jsonResult({
          ok: true,
          messageId: result.transportMessageId ?? transportMessageId,
          conversationId: result.conversationId,
        });
      }

      if (action === "delete") {
        const transportMessageId = readActionTransportMessageId({
          rawParams: params,
          required: true,
        })!;
        const result = await runtime.sendAction({
          kind: "message.delete",
          target,
          payload: {
            transportMessageId,
          },
          explicitThreadId,
        });
        return jsonResult({
          ok: true,
          messageId: result.transportMessageId ?? transportMessageId,
          conversationId: result.conversationId,
        });
      }

      if (action === "react") {
        const transportMessageId = readActionTransportMessageId({
          rawParams: params,
          fallbackMessageId: toolContext?.currentMessageId,
          required: true,
        })!;
        const reaction = readReactionParams(params, {
          removeErrorMessage: "Emoji is required to remove a reaction.",
        });
        const emojis = reaction.remove || reaction.isEmpty ? [] : [reaction.emoji];
        const result = await runtime.sendAction({
          kind: "reaction.set",
          target,
          payload: {
            transportMessageId,
            emojis,
          },
          explicitThreadId,
        });
        return jsonResult({
          ok: true,
          messageId: result.transportMessageId ?? transportMessageId,
          conversationId: result.conversationId,
          ...(emojis.length > 0 ? { added: reaction.emoji } : { removed: true }),
        });
      }

      if (action === "pin" || action === "unpin") {
        const transportMessageId = readActionTransportMessageId({
          rawParams: params,
          required: action === "pin",
        });
        const result = await runtime.sendAction({
          kind: action === "pin" ? "message.pin" : "message.unpin",
          target,
          payload: {
            ...(transportMessageId ? { transportMessageId } : {}),
            ...(action === "pin" && readBooleanParam(params, "disableNotification") !== undefined
              ? { disableNotification: readBooleanParam(params, "disableNotification") === true }
              : {}),
          },
          explicitThreadId,
        });
        return jsonResult({
          ok: true,
          messageId: result.transportMessageId ?? transportMessageId ?? "",
          conversationId: result.conversationId,
        });
      }

      throw new Error(`Unsupported relay-channel action: ${action}`);
    },
  },
  outbound: {
    deliveryMode: "direct" as const,
    sendPayload: async (input: any) => {
      const { cfg, to, payload, accountId, replyToId, threadId, forceDocument } = input;
      const runtime = await ensureRuntimeStarted(cfg, accountId);
      const { target, explicitThreadId } = resolveOutboundTarget(to, threadId ?? null);
      const telegramChannelData =
        isRecord(payload?.channelData) && isRecord(payload.channelData.telegram)
          ? payload.channelData.telegram
          : null;
      const buttons = readTelegramInlineButtons(telegramChannelData?.buttons, payload?.interactive);
      const replyMarkup = buildReplyMarkup(buttons);
      const text =
        resolveInteractiveTextFallback({
          text: typeof payload?.text === "string" ? payload.text : undefined,
          interactive: payload?.interactive,
        }) ?? "";
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
          ...(replyMarkup ? { replyMarkup } : {}),
        },
        replyToTransportMessageId: replyToId ?? null,
        explicitThreadId,
      });
      return buildOpenClawOutboundResult(result, "relay-message");
    },
    sendText: async ({ cfg, to, text, accountId, replyToId, threadId }) => {
      const runtime = await ensureRuntimeStarted(cfg, accountId);
      const { target, explicitThreadId } = resolveOutboundTarget(to, threadId ?? null);
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
      const { target, explicitThreadId } = resolveOutboundTarget(to, threadId ?? null);
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
    sendPoll: async ({ cfg, to, poll, accountId, threadId, silent, isAnonymous }) => {
      const runtime = await ensureRuntimeStarted(cfg, accountId);
      const { target, explicitThreadId } = resolveOutboundTarget(to, threadId ?? null);
      const result = await runtime.sendAction({
        kind: "poll.send",
        target,
        payload: {
          question: poll.question,
          options: poll.options,
          ...(typeof poll.maxSelections === "number" && poll.maxSelections > 1
            ? { allowsMultipleAnswers: true }
            : {}),
          ...(typeof poll.durationSeconds === "number"
            ? { durationSeconds: poll.durationSeconds }
            : {}),
          ...(typeof poll.durationHours === "number"
            ? { durationHours: poll.durationHours }
            : {}),
          ...(silent !== undefined ? { silent } : {}),
          ...(isAnonymous !== undefined ? { isAnonymous } : {}),
        },
        explicitThreadId,
      });
      return {
        messageId: result.transportMessageId ?? result.conversationId ?? "relay-poll",
        conversationId: result.conversationId,
      };
    },
    requestFileDownload: async (input: any) => {
      const { cfg, to, accountId, fileId } = input;
      const runtime = await ensureRuntimeStarted(cfg, accountId);
      const resolvedTarget = resolveTarget(to);
      const result = await runtime.sendAction({
        kind: "file.download.request",
        target: resolvedTarget,
        payload: { fileId },
      });
      return buildOpenClawOutboundResult(result, "relay-download");
    },
  },
} as ChannelPlugin<RelayResolvedAccount>;
