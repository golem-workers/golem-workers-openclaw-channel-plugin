import {
  buildChannelConfigSchema,
  createChannelPluginBase,
  type ChannelPlugin,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/core";
import { RelayAccountRuntime } from "./account-runtime.js";
import { parseRelayChannelPluginConfig, relayChannelPluginConfigSchema, resolveAccountConfig } from "./config.js";
import { describeMessageTool } from "./message-actions.js";
import { resolveOutboundSessionRoute } from "./outbound-session-route.js";
import { InMemoryPersistence } from "./persistence.js";
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

function mapRelayScopeToDirectoryKind(scope: "dm" | "group" | "topic") {
  return scope === "dm" ? "user" : "group";
}

function mapRelayScopeToChatType(scope: "dm" | "group" | "topic") {
  return scope === "dm" ? "direct" : "group";
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

const persistence = new InMemoryPersistence();
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
    statusRegistry,
    persistence
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
    async startAccount({ cfg, accountId, account }) {
      return await ensureRuntimeStarted(cfg, accountId ?? account?.accountId ?? null);
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
        to: `${parsed.channel}:${parsed.scope}:${parsed.conversationId}`,
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
      hint: "Use explicit relay target like telegram:group:<chatId> or telegram:topic:<chatId>#<threadId>",
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
      return {
        actions: describeMessageTool(runtime.getCapabilitySnapshot()).actions,
      };
    },
  },
  outbound: {
    deliveryMode: "direct" as const,
    sendText: async ({ cfg, to, text, accountId, replyToId, threadId }) => {
      const runtime = await ensureRuntimeStarted(cfg, accountId);
      const resolvedTarget = resolveTarget(to);
      const result = await runtime.sendAction({
        kind: "message.send",
        target: {
          ...resolvedTarget,
          threadId:
            threadId !== undefined && threadId !== null
              ? String(threadId)
              : resolvedTarget.threadId ?? null,
        },
        payload: { text },
        replyToTransportMessageId: replyToId ?? null,
        explicitThreadId:
          threadId !== undefined && threadId !== null ? String(threadId) : null,
      });
      return {
        channel: CHANNEL_ID,
        messageId: result.transportMessageId ?? result.conversationId ?? "relay-message",
        conversationId: result.conversationId,
        meta: result,
      };
    },
  },
} as ChannelPlugin<RelayResolvedAccount>;
