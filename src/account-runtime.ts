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
import { RelayStatusRegistry } from "./status.js";
import { InMemoryPersistence } from "./persistence.js";
import { ThreadBindingStore } from "./thread-bindings.js";

export class RelayAccountRuntime {
  private client: RelayClient | null = null;
  private readonly threadBindings: ThreadBindingStore;

  public constructor(
    private readonly config: RelayChannelPluginConfig,
    private readonly accountId: string,
    private readonly statusRegistry: RelayStatusRegistry,
    private readonly persistence: InMemoryPersistence,
    private readonly onInboundMessage?: (
      message: ReturnType<typeof mapInboundMessageEvent>
    ) => void,
    private readonly onTransportEvent?: (event: RelayTransportEvent) => void
  ) {
    this.threadBindings = new ThreadBindingStore(persistence);
  }

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
        this.persistence.setCapabilitySnapshot(this.accountId, status.capabilities);
        this.statusRegistry.setHealthy(this.accountId, status.capabilities);
      } else if (status.state === "connecting") {
        this.statusRegistry.setConnecting(this.accountId);
      } else if (status.state === "degraded") {
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
      if (mapped.cursor) {
        this.persistence.setReplayCursor(this.accountId, mapped.cursor);
      }
      if (mapped.sessionConversation.id && mapped.sessionConversation.threadId) {
        this.threadBindings.remember(
          mapped.sessionConversation.id,
          mapped.sessionConversation.threadId
        );
      }
      this.onInboundMessage?.(mapped);
    });

    client.on("transportEvent", (event: RelayTransportEvent) => {
      this.onTransportEvent?.(event);
    });

    client.on("capabilities", (snapshot: RelayCapabilitySnapshot) => {
      this.persistence.setCapabilitySnapshot(this.accountId, snapshot);
    });

    client.on("replayGap", (gap) => {
      this.statusRegistry.setDegraded(
        this.accountId,
        `Replay gap: ${gap.reason}`,
        this.persistence.getCapabilitySnapshot(this.accountId)
      );
    });

    this.client = client;
    this.statusRegistry.setConnecting(this.accountId);
    await client.start();
    const replayCursor = this.persistence.getReplayCursor(this.accountId);
    if (replayCursor) {
      client.requestReplay(replayCursor);
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
    return this.client?.getCapabilitySnapshot() ?? this.persistence.getCapabilitySnapshot(this.accountId);
  }

  public getThreadBinding(sessionKey: string): string | undefined {
    return this.threadBindings.resolve(sessionKey);
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
    const threadId = input.explicitThreadId ?? input.target.threadId ?? null;
    const conversationId = input.target.transportTarget.chatId ?? input.target.to;
    const action: RelayActionPayload = {
      actionId,
      kind: input.kind,
      idempotencyKey,
      accountId: this.accountId,
      targetScope: input.target.kind,
      transportTarget: input.target.transportTarget,
      conversation: {
        transportConversationId: conversationId,
        baseConversationId: conversationId,
        parentConversationCandidates: [conversationId],
      },
      thread: {
        threadId,
      },
      reply: {
        replyToTransportMessageId: input.replyToTransportMessageId ?? null,
      },
      payload: input.payload,
      openclawContext: input.sessionKey ? { sessionKey: input.sessionKey } : undefined,
    };

    this.persistence.setActionRecord({
      actionId,
      accountId: this.accountId,
      idempotencyKey,
      acceptedAtMs: Date.now(),
      terminalState: undefined,
      cursor: this.persistence.getReplayCursor(this.accountId) ?? null,
    });

    const result = await this.client.dispatchAction(action);
    this.persistence.setActionRecord({
      actionId,
      accountId: this.accountId,
      idempotencyKey,
      acceptedAtMs: Date.now(),
      terminalState: "completed",
      cursor: this.persistence.getReplayCursor(this.accountId) ?? null,
    });
    return result;
  }
}
