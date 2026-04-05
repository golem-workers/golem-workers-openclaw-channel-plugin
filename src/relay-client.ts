import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import type {
  RelayActionFailure,
  RelayActionPayload,
  RelayActionSuccess,
  RelayCapabilitySnapshot,
} from "../api.js";
import {
  helloRequestSchema,
  parseControlPlaneMessage,
  transportActionRequestSchema,
} from "./protocol/control-plane.js";
import { logRuntimeEvent } from "./runtime-log.js";
import { REQUIRED_CORE_CAPABILITIES } from "./types.js";

type PendingAction = {
  actionId: string;
  resolve: (value: RelayActionSuccess) => void;
  reject: (reason?: unknown) => void;
  timeout: ReturnType<typeof setTimeout>;
  settled: boolean;
};

export type RelayClientOptions = {
  accountId: string;
  url: string;
  reconnectBackoffMs: number;
  maxReconnectBackoffMs: number;
  requestTimeoutMs: number;
  requiredCoreCapabilities?: string[];
};

export class RelayClient extends EventEmitter {
  private socket: WebSocket | null = null;
  private reconnectDelayMs: number;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private helloResolved = false;
  private pendingActions = new Map<string, PendingAction>();
  private capabilitySnapshot?: RelayCapabilitySnapshot;
  private dataPlane?: {
    uploadBaseUrl: string;
    downloadBaseUrl: string;
  };

  public constructor(private readonly options: RelayClientOptions) {
    super();
    this.reconnectDelayMs = options.reconnectBackoffMs;
  }

  public async start(): Promise<RelayCapabilitySnapshot> {
    this.started = true;
    logRuntimeEvent("info", "Starting relay control-plane client", {
      accountId: this.options.accountId,
      url: this.options.url,
    });
    return await this.openSocket();
  }

  public async stop(): Promise<void> {
    this.started = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    logRuntimeEvent("info", "Stopping relay control-plane client", {
      accountId: this.options.accountId,
    });
    if (this.socket) {
      const socket = this.socket;
      this.socket = null;
      if (socket.readyState === WebSocket.CLOSED) {
        this.emit("status", { state: "stopped" });
        return;
      }
      await new Promise<void>((resolve) => {
        socket.once("close", () => resolve());
        socket.close();
      });
    }
    this.emit("status", { state: "stopped" });
  }

  public getCapabilitySnapshot(): RelayCapabilitySnapshot | undefined {
    return this.capabilitySnapshot;
  }

  public getDataPlane() {
    return this.dataPlane;
  }

  public async dispatchAction(action: RelayActionPayload): Promise<RelayActionSuccess> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("ACCOUNT_NOT_READY: relay socket is not connected");
    }

    const requestId = randomUUID();
    const frame = transportActionRequestSchema.parse({
      type: "request",
      requestType: "transport.action",
      requestId,
      action,
    });

    return await new Promise<RelayActionSuccess>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const pending = this.pendingActions.get(requestId);
        if (!pending || pending.settled) {
          return;
        }
        pending.settled = true;
        this.pendingActions.delete(requestId);
        reject(new Error("transport action timed out"));
      }, this.options.requestTimeoutMs);

      this.pendingActions.set(requestId, {
        actionId: action.actionId,
        resolve,
        reject,
        timeout,
        settled: false,
      });

      try {
        this.socket?.send(JSON.stringify(frame));
      } catch (error) {
        clearTimeout(timeout);
        this.pendingActions.delete(requestId);
        reject(error);
      }
    });
  }

  private async openSocket(): Promise<RelayCapabilitySnapshot> {
    return await new Promise<RelayCapabilitySnapshot>((resolve, reject) => {
      const socket = new WebSocket(this.options.url);
      this.socket = socket;
      this.helloResolved = false;
      let suppressReconnect = false;
      logRuntimeEvent("info", "Connecting relay control-plane socket", {
        accountId: this.options.accountId,
        url: this.options.url,
      });
      this.emit("status", { state: "connecting" });

      const fail = (error: unknown) => {
        if (!this.helloResolved) {
          suppressReconnect = isFatalStartupError(error);
          const reason = error instanceof Error ? error.message : "Relay connection failed";
          logRuntimeEvent(suppressReconnect ? "error" : "warn", "Relay control-plane connect failed", {
            accountId: this.options.accountId,
            reason,
            fatal: suppressReconnect,
          });
          if (this.started && !suppressReconnect) {
            this.emit("status", {
              state: "degraded",
              reason,
              capabilities: this.capabilitySnapshot,
            });
            this.scheduleReconnect();
          }
          reject(error);
        }
      };

      socket.once("open", () => {
        try {
          const hello = helloRequestSchema.parse({
            type: "hello",
            protocolVersion: 1,
            role: "openclaw-channel-plugin",
            channelId: "relay-channel",
            instanceId: `${this.options.accountId}-instance`,
            accountId: this.options.accountId,
            supports: {
              asyncLifecycle: true,
              fileDownloadRequests: true,
              capabilityNegotiation: true,
              accountScopedStatus: true,
            },
            requestedCapabilities: {
              core: [...REQUIRED_CORE_CAPABILITIES],
              optional: [
                "messageEdit",
                "messageDelete",
                "reactions",
                "typing",
                "polls",
                "pinning",
                "fileDownloads",
                "telegram.inlineButtons",
                "telegram.forumTopics",
                "telegram.callbackAnswer",
              ],
            },
          });
          socket.send(JSON.stringify(hello));
        } catch (error) {
          fail(error);
        }
      });

      socket.on("message", (raw) => {
        try {
          const parsed = parseControlPlaneMessage(raw.toString());
          if (parsed.type === "hello") {
            const snapshot: RelayCapabilitySnapshot = {
              coreCapabilities: parsed.coreCapabilities,
              optionalCapabilities: parsed.optionalCapabilities,
              providerCapabilities: parsed.providerCapabilities,
              providerFeatures: parsed.providerFeatures,
              providerProfiles: parsed.providerProfiles,
              targetCapabilities: parsed.targetCapabilities,
              limits: parsed.limits,
              transport: parsed.transport,
            };
            this.assertRequiredCapabilities(snapshot);
            this.capabilitySnapshot = snapshot;
            this.dataPlane = parsed.dataPlane;
            this.reconnectDelayMs = this.options.reconnectBackoffMs;
            this.helloResolved = true;
            logRuntimeEvent("info", "Relay control-plane socket became healthy", {
              accountId: this.options.accountId,
              provider: snapshot.transport.provider,
            });
            this.emit("capabilities", snapshot);
            this.emit("status", { state: "healthy", capabilities: snapshot });
            resolve(snapshot);
            return;
          }

          this.handleEvent(parsed);
        } catch (error) {
          fail(error);
          logRuntimeEvent("warn", "Relay control-plane protocol error", {
            accountId: this.options.accountId,
            reason: error instanceof Error ? error.message : String(error),
          });
          this.emit("protocolError", error);
        }
      });

      socket.on("close", () => {
        if (this.socket === socket) {
          this.socket = null;
        }
        this.failPendingActions({
          code: "ACCOUNT_NOT_READY",
          message: "Relay socket closed",
          retryable: true,
        });
        if (this.started && !suppressReconnect) {
          const capabilities = this.capabilitySnapshot;
          logRuntimeEvent("warn", "Relay control-plane socket disconnected", {
            accountId: this.options.accountId,
            reconnectInMs: this.reconnectDelayMs,
          });
          this.emit("status", {
            state: "degraded",
            reason: "Relay socket disconnected",
            capabilities,
          });
          this.scheduleReconnect();
        }
      });

      socket.on("error", (error) => {
        fail(error);
      });
    });
  }

  private handleEvent(event: ReturnType<typeof parseControlPlaneMessage>) {
    if (event.type !== "event") {
      return;
    }

    switch (event.eventType) {
      case "transport.action.accepted": {
        this.emit("actionAccepted", event.payload);
        break;
      }
      case "transport.action.completed": {
        const pending = this.pendingActions.get(event.payload.requestId);
        if (!pending || pending.settled) {
          return;
        }
        pending.settled = true;
        clearTimeout(pending.timeout);
        this.pendingActions.delete(event.payload.requestId);
        pending.resolve(event.payload.result);
        break;
      }
      case "transport.action.failed": {
        const pending = this.pendingActions.get(event.payload.requestId);
        if (!pending || pending.settled) {
          return;
        }
        pending.settled = true;
        clearTimeout(pending.timeout);
        this.pendingActions.delete(event.payload.requestId);
        pending.reject(new Error(`${event.payload.error.code}: ${event.payload.error.message}`));
        break;
      }
      case "transport.message.received": {
        this.emit("inboundMessage", event);
        break;
      }
      case "transport.message.edited":
      case "transport.message.deleted":
      case "transport.reaction.updated":
      case "transport.callback.received":
      case "transport.poll.updated":
      case "transport.topic.updated":
      case "transport.delivery.receipt":
      case "transport.typing.updated": {
        this.emit("transportEvent", event);
        break;
      }
      case "transport.account.connecting":
      case "transport.account.ready":
      case "transport.account.degraded":
      case "transport.account.disconnected":
      case "transport.account.status": {
        const status =
          event.payload.state === "healthy"
            ? { state: "healthy", capabilities: this.capabilitySnapshot }
            : event.payload.state === "connecting"
              ? { state: "connecting" }
              : event.payload.state === "stopped"
                ? { state: "stopped" }
                : {
                    state: "degraded",
                    reason: event.payload.reason ?? "Relay reported degraded state",
                    capabilities: this.capabilitySnapshot,
                  };
        this.emit("status", status);
        break;
      }
      case "transport.capabilities.updated": {
        this.capabilitySnapshot = event.payload;
        this.emit("capabilities", event.payload);
        this.emit("status", { state: "healthy", capabilities: event.payload });
        break;
      }
      case "transport.protocol.error": {
        this.emit("protocolError", new Error(`${event.payload.code}: ${event.payload.message}`));
        break;
      }
      default:
        break;
    }
  }

  private scheduleReconnect() {
    if (this.reconnectTimer || !this.started) {
      return;
    }
    const reconnectDelayMs = this.reconnectDelayMs;
    logRuntimeEvent("info", "Scheduling relay control-plane reconnect", {
      accountId: this.options.accountId,
      reconnectInMs: reconnectDelayMs,
    });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      logRuntimeEvent("info", "Attempting relay control-plane reconnect", {
        accountId: this.options.accountId,
      });
      void this.openSocket().catch((error) => {
        const reason = error instanceof Error ? error.message : "Reconnect failed";
        logRuntimeEvent("warn", "Relay control-plane reconnect failed", {
          accountId: this.options.accountId,
          reason,
          nextReconnectInMs: Math.min(
            this.reconnectDelayMs * 2,
            this.options.maxReconnectBackoffMs
          ),
        });
        this.emit("status", {
          state: "degraded",
          reason,
          capabilities: this.capabilitySnapshot,
        });
        this.reconnectDelayMs = Math.min(
          this.reconnectDelayMs * 2,
          this.options.maxReconnectBackoffMs
        );
        this.scheduleReconnect();
      });
    }, reconnectDelayMs);
  }

  private assertRequiredCapabilities(snapshot: RelayCapabilitySnapshot) {
    const required = new Set([
      ...REQUIRED_CORE_CAPABILITIES,
      ...(this.options.requiredCoreCapabilities ?? []),
    ]);
    for (const capability of required) {
      if (!snapshot.coreCapabilities[capability]) {
        throw new Error(`CAPABILITY_MISSING: missing required core capability ${capability}`);
      }
    }
  }

  private failPendingActions(error: RelayActionFailure) {
    for (const [requestId, pending] of this.pendingActions.entries()) {
      if (pending.settled) {
        continue;
      }
      pending.settled = true;
      clearTimeout(pending.timeout);
      pending.reject(new Error(`${error.code}: ${error.message}`));
      this.pendingActions.delete(requestId);
    }
  }
}

function isFatalStartupError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /^CAPABILITY_MISSING:/u.test(message);
}
