import { randomUUID } from "node:crypto";
import type {
  RelayActionPayload,
  RelayAccountStatus,
  RelayCapabilitySnapshot,
  RelayChannelPluginConfig,
  RelayRecoveryState,
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
          recovering: status.recovering,
        });
        this.statusRegistry.setHealthy(
          this.accountId,
          status.capabilities,
          pickRecoveryState(status)
        );
      } else if (status.state === "connecting") {
        logRuntimeEvent("info", "Relay account runtime connecting", {
          accountId: this.accountId,
          recovering: status.recovering,
          reconnectScheduled: status.reconnectScheduled,
        });
        this.statusRegistry.setConnecting(this.accountId, pickRecoveryState(status));
      } else if (status.state === "degraded") {
        logRuntimeEvent("warn", "Relay account runtime degraded", {
          accountId: this.accountId,
          reason: status.reason,
          recovering: status.recovering,
          reconnectScheduled: status.reconnectScheduled,
          nextReconnectInMs: status.nextReconnectInMs,
          lastCloseCode: status.lastCloseCode,
          lastCloseReason: status.lastCloseReason,
        });
        this.statusRegistry.setDegraded(
          this.accountId,
          status.reason,
          status.capabilities,
          pickRecoveryState(status)
        );
      } else {
        this.statusRegistry.setStopped(this.accountId, pickRecoveryState(status));
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
      this.statusRegistry.setHealthy(
        this.accountId,
        snapshot,
        pickRecoveryState(this.statusRegistry.get(this.accountId))
      );
    });

    client.on("protocolError", (error) => {
      logRuntimeEvent("warn", "Relay account runtime protocol error", {
        accountId: this.accountId,
        reason: error instanceof Error ? error.message : String(error),
      });
    });

    this.client = client;
    this.statusRegistry.setConnecting(this.accountId, {
      recovering: false,
      reconnectScheduled: false,
      nextReconnectInMs: null,
    });
    try {
      await client.start();
    } catch (error) {
      this.client = null;
      const reason = error instanceof Error ? error.message : "Relay connection failed";
      this.statusRegistry.setDegraded(
        this.accountId,
        reason,
        client.getCapabilitySnapshot(),
        {
          recovering: false,
          reconnectScheduled: false,
          nextReconnectInMs: null,
        }
      );
      throw error;
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

function pickRecoveryState(status: RelayAccountStatus): Partial<RelayRecoveryState> {
  return {
    recovering: status.recovering,
    reconnectScheduled: status.reconnectScheduled,
    reconnectAttempts: status.reconnectAttempts,
    nextReconnectInMs: status.nextReconnectInMs,
    lastDisconnectReason: status.lastDisconnectReason,
    lastCloseCode: status.lastCloseCode,
    lastCloseReason: status.lastCloseReason,
  };
}
