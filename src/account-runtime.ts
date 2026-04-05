import { randomUUID } from "node:crypto";
import type {
  RelayActionPayload,
  RelayAccountStatus,
  RelayCapabilitySnapshot,
  RelayChannelPluginConfig,
  RelayResolvedTarget,
  RelayTransportEvent,
} from "../api.js";
import { resolveAccountConfig } from "./config.js";
import { mapInboundMessageEvent } from "./relay-events.js";
import { RelayClient } from "./relay-client.js";
import { logRuntimeEvent } from "./runtime-log.js";
import { RelayStatusRegistry } from "./status.js";

export class RelayAccountRuntime {
  private client: RelayClient | null = null;

  public constructor(
    private readonly config: RelayChannelPluginConfig,
    private readonly accountId: string,
    private readonly statusRegistry: RelayStatusRegistry,
    private readonly onInboundMessage?: (
      message: ReturnType<typeof mapInboundMessageEvent>
    ) => void,
    private readonly onTransportEvent?: (event: RelayTransportEvent) => void
  ) {}

  public async start(): Promise<RelayAccountStatus> {
    if (this.client) {
      return this.statusRegistry.get(this.accountId);
    }
    const accountConfig = resolveAccountConfig(this.config, this.accountId);
    const client = new RelayClient({
      accountId: this.accountId,
      url: accountConfig.url,
      reconnectBackoffMs: accountConfig.reconnectBackoffMs,
      maxReconnectBackoffMs: accountConfig.maxReconnectBackoffMs,
      requestTimeoutMs: accountConfig.requestTimeoutMs,
      requiredCoreCapabilities: this.config.capabilityRequirements?.core,
    });

    client.on("status", (status: RelayAccountStatus) => {
      if (status.state === "healthy") {
        logRuntimeEvent("info", "Relay account runtime healthy", {
          accountId: this.accountId,
        });
        this.statusRegistry.setHealthy(this.accountId, status.capabilities);
      } else if (status.state === "connecting") {
        logRuntimeEvent("info", "Relay account runtime connecting", {
          accountId: this.accountId,
        });
        this.statusRegistry.setConnecting(this.accountId);
      } else if (status.state === "degraded") {
        logRuntimeEvent("warn", "Relay account runtime degraded", {
          accountId: this.accountId,
          reason: status.reason,
        });
        this.statusRegistry.setDegraded(
          this.accountId,
          status.reason,
          status.capabilities
        );
      } else {
        this.statusRegistry.setStopped(this.accountId);
      }
    });

    client.on("inboundMessage", (event) => {
      const mapped = mapInboundMessageEvent(event);
      this.onInboundMessage?.(mapped);
    });

    client.on("transportEvent", (event: RelayTransportEvent) => {
      this.onTransportEvent?.(event);
    });

    client.on("capabilities", (snapshot: RelayCapabilitySnapshot) => {
      this.statusRegistry.setHealthy(this.accountId, snapshot);
    });

    client.on("protocolError", (error) => {
      logRuntimeEvent("warn", "Relay account runtime protocol error", {
        accountId: this.accountId,
        reason: error instanceof Error ? error.message : String(error),
      });
    });

    this.client = client;
    this.statusRegistry.setConnecting(this.accountId);
    try {
      await client.start();
    } catch (error) {
      if (isFatalRelayStartupError(error)) {
        this.client = null;
        throw error;
      }
      logRuntimeEvent("warn", "Relay account runtime entered degraded startup mode", {
        accountId: this.accountId,
        reason: error instanceof Error ? error.message : "Relay connection failed",
      });
      this.statusRegistry.setDegraded(
        this.accountId,
        error instanceof Error ? error.message : "Relay connection failed",
        client.getCapabilitySnapshot()
      );
      return this.statusRegistry.get(this.accountId);
    }
    return this.statusRegistry.get(this.accountId);
  }

  public async stop(): Promise<RelayAccountStatus> {
    if (!this.client) {
      this.statusRegistry.setStopped(this.accountId);
      return this.statusRegistry.get(this.accountId);
    }
    const client = this.client;
    this.client = null;
    await client.stop();
    this.statusRegistry.setStopped(this.accountId);
    return this.statusRegistry.get(this.accountId);
  }

  public getStatus(): RelayAccountStatus {
    return this.statusRegistry.get(this.accountId);
  }

  public getCapabilitySnapshot(): RelayCapabilitySnapshot | undefined {
    const live = this.client?.getCapabilitySnapshot();
    if (live) {
      return live;
    }
    const status = this.statusRegistry.get(this.accountId);
    return "capabilities" in status ? status.capabilities : undefined;
  }

  public async sendAction(input: {
    kind: RelayActionPayload["kind"];
    target: RelayResolvedTarget;
    payload: RelayActionPayload["payload"];
    replyToTransportMessageId?: string | null;
    sessionKey?: string;
    idempotencyKey?: string;
    explicitThreadId?: string | null;
  }) {
    if (!this.client) {
      throw new Error("ACCOUNT_NOT_READY: account runtime has not been started");
    }
    const actionId = randomUUID();
    const idempotencyKey = input.idempotencyKey ?? actionId;
    const threadHandle =
      input.explicitThreadId ??
      input.target.threadHandle ??
      input.target.threadId ??
      null;
    const conversationHandle =
      input.target.conversationHandle ?? input.target.transportTarget.chatId ?? input.target.to;
    const conversationId = conversationHandle;
    const action: RelayActionPayload = {
      actionId,
      kind: input.kind,
      idempotencyKey,
      accountId: this.accountId,
      transportTarget: input.target.transportTarget,
      conversation: {
        handle: conversationHandle,
        baseConversationId: conversationId,
        parentConversationCandidates: [conversationId],
      },
      thread: {
        handle: threadHandle,
      },
      reply: {
        replyToTransportMessageId: input.replyToTransportMessageId ?? null,
      },
      payload: input.payload,
      openclawContext: input.sessionKey ? { sessionKey: input.sessionKey } : undefined,
    };
    return await this.client.dispatchAction(action);
  }
}

function isFatalRelayStartupError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /^CAPABILITY_MISSING:/u.test(message);
}
