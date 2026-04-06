import { z } from "zod";
import type { RelayChannelPluginConfig } from "../api.js";

const accountSchema = z.object({
  id: z.string().min(1),
  url: z.string().url().optional(),
  port: z.number().int().positive().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const relayChannelPluginConfigSchema = z.object({
  enabled: z.boolean().optional().default(true),
  url: z.string().url().optional(),
  port: z.number().int().positive().optional(),
  reconnectBackoffMs: z.number().int().positive().optional().default(500),
  maxReconnectBackoffMs: z.number().int().positive().optional().default(30_000),
  requestTimeoutMs: z.number().int().positive().optional().default(10_000),
  capabilityRequirements: z.object({
    core: z.array(z.string()).optional().default([]),
    optional: z.array(z.string()).optional().default([]),
  }).optional().default({ core: [], optional: [] }),
  dmSecurityPolicy: z.object({
    mode: z.enum(["allow_all", "allow_list"]).optional().default("allow_all"),
    allowedTargets: z.array(z.string()).optional().default([]),
  }).optional().default({ mode: "allow_all", allowedTargets: [] }),
  pairing: z.object({
    mode: z.enum(["same_chat_only", "disabled"]).optional().default("same_chat_only"),
    approvalRequired: z.boolean().optional().default(false),
  }).optional().default({ mode: "same_chat_only", approvalRequired: false }),
  directory: z.object({
    enabled: z.boolean().optional().default(true),
  }).optional().default({ enabled: true }),
  accounts: z.array(accountSchema).min(1),
});

export function parseRelayChannelPluginConfig(input: unknown): RelayChannelPluginConfig {
  const parsed = relayChannelPluginConfigSchema.parse(input);
  return {
    ...parsed,
    accounts: parsed.accounts.map((account) => ({
      ...account,
      url: account.url ?? parsed.url ?? buildLoopbackUrl(account.port ?? parsed.port ?? 43129),
      port: account.port ?? parsed.port,
      metadata: account.metadata as Record<string, never> | undefined,
    })),
  };
}

export function resolveAccountConfig(
  config: RelayChannelPluginConfig,
  accountId: string
) {
  const account = config.accounts.find((entry) => entry.id === accountId);
  if (!account) {
    throw new Error(`Unknown account: ${accountId}`);
  }

  return {
    ...account,
    url: account.url ?? config.url ?? buildLoopbackUrl(account.port ?? config.port ?? 43129),
    reconnectBackoffMs: config.reconnectBackoffMs ?? 500,
    maxReconnectBackoffMs: config.maxReconnectBackoffMs ?? 30_000,
    requestTimeoutMs: config.requestTimeoutMs ?? 10_000,
  };
}

function buildLoopbackUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}
