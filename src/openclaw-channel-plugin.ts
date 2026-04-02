import {
  buildChannelConfigSchema,
  createChannelPluginBase,
  type ChannelPlugin,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/core";
import { relayChannelPluginConfigSchema, parseRelayChannelPluginConfig, resolveAccountConfig } from "./config.js";
import { inspectRelaySetup } from "./setup.js";

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

export const relayChannelOpenclawPlugin = createChannelPluginBase<RelayResolvedAccount>({
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
}) as ChannelPlugin<RelayResolvedAccount>;
