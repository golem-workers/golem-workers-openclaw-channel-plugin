import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import type {
  RelayActionFailure,
  RelayAccountStatus,
  RelayActionPayload,
  RelayActionSuccess,
  RelayCapabilitySnapshot,
  RelayRecoveryState,
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
  private reconnectAttempts = 0;
  private lastDisconnectReason: string | null = null;
  private lastCloseCode: number | null = null;
  private lastCloseReason: string | null = null;
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

  public async start(): Promise<RelayCapabilitySnapshot | undefined> {
    this.started = true;
    logRuntimeEvent("info", "Starting relay control-plane client", {
      accountId: this.options.accountId,
      url: this.options.url,
    });
    try {
      return await this.openSocket({ recovering: false });
    } catch (error) {
      if (isFatalStartupError(error)) {
        throw error;
      }
      return undefined;
    }
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
        this.emit("status", this.buildStoppedStatus());
        return;
      }
      await new Promise<void>((resolve) => {
        socket.once("close", () => resolve());
        socket.close();
      });
    }
    this.reconnectAttempts = 0;
    this.emit("status", this.buildStoppedStatus());
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

  private async openSocket(input: { recovering: boolean }): Promise<RelayCapabilitySnapshot> {
    return await new Promise<RelayCapabilitySnapshot>((resolve, reject) => {
      const socket = new WebSocket(this.options.url);
      this.socket = socket;
      this.helloResolved = false;
      let suppressReconnect = false;
      let startupFailureHandled = false;
      logRuntimeEvent("info", "Connecting relay control-plane socket", {
        accountId: this.options.accountId,
        url: this.options.url,
        recovering: input.recovering,
        reconnectAttempts: this.reconnectAttempts,
      });
      this.emit("status", this.buildConnectingStatus({ recovering: input.recovering }));

      const fail = (error: unknown) => {
        if (this.helloResolved || startupFailureHandled) {
          return;
        }
        startupFailureHandled = true;
        suppressReconnect = isFatalStartupError(error);
        const reason = error instanceof Error ? error.message : "Relay connection failed";
        this.lastDisconnectReason = reason;
        this.lastCloseCode = null;
        this.lastCloseReason = null;
        logRuntimeEvent(suppressReconnect ? "error" : "warn", "Relay control-plane connect failed", {
          accountId: this.options.accountId,
          reason,
          fatal: suppressReconnect,
          recovering: input.recovering,
          reconnectAttempts: this.reconnectAttempts,
          reconnectAlreadyScheduled: Boolean(this.reconnectTimer),
        });
        if (this.started && !suppressReconnect) {
          if (input.recovering) {
            this.reconnectDelayMs = Math.min(
              this.reconnectDelayMs * 2,
              this.options.maxReconnectBackoffMs
            );
          }
          this.scheduleReconnect(reason);
        }
        reject(error);
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
              optional: ["typing", "fileDownloads"],
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
            this.reconnectAttempts = 0;
            this.helloResolved = true;
            logRuntimeEvent("info", "Relay control-plane socket became healthy", {
              accountId: this.options.accountId,
              provider: snapshot.transport.provider,
              recovering: input.recovering,
            });
            this.emit("capabilities", snapshot);
            this.emit("status", this.buildHealthyStatus(snapshot));
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

      socket.on("close", (code, reasonBuffer) => {
        if (this.socket === socket) {
          this.socket = null;
        }
        const closeReason = decodeCloseReason(reasonBuffer);
        this.lastCloseCode = normalizeCloseCode(code);
        this.lastCloseReason = closeReason;
        const disconnectReason = describeDisconnect({
          code: this.lastCloseCode,
          reason: closeReason,
          helloResolved: this.helloResolved,
        });
        this.lastDisconnectReason = disconnectReason;
        const pendingActionCount = this.pendingActions.size;
        this.failPendingActions({
          code: "ACCOUNT_NOT_READY",
          message: "Relay socket closed",
          retryable: true,
        });
        if (!this.helloResolved) {
          if (!startupFailureHandled) {
            fail(new Error(disconnectReason));
          }
          return;
        }
        if (this.started && !suppressReconnect) {
          logRuntimeEvent("warn", "Relay control-plane socket disconnected", {
            accountId: this.options.accountId,
            reason: disconnectReason,
            closeCode: this.lastCloseCode,
            closeReason: this.lastCloseReason,
            pendingActionCount,
            reconnectAlreadyScheduled: Boolean(this.reconnectTimer),
            reconnectInMs: this.reconnectDelayMs,
          });
          this.scheduleReconnect(disconnectReason);
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
            ? this.buildHealthyStatus(this.capabilitySnapshot)
            : event.payload.state === "connecting"
              ? this.buildConnectingStatus({
                  recovering: this.started,
                })
              : event.payload.state === "stopped"
                ? this.buildStoppedStatus()
                : {
                    ...this.buildRecoveryState({
                      recovering: this.started,
                    }),
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
        this.emit("status", this.buildHealthyStatus(event.payload));
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

  private scheduleReconnect(reason: string) {
    if (!this.started) {
      return;
    }
    if (this.reconnectTimer) {
      logRuntimeEvent("info", "Relay control-plane reconnect already scheduled", {
        accountId: this.options.accountId,
        reason,
        reconnectInMs: this.reconnectDelayMs,
        reconnectAttempts: this.reconnectAttempts,
      });
      return;
    }
    const reconnectDelayMs = this.reconnectDelayMs;
    logRuntimeEvent("info", "Scheduling relay control-plane reconnect", {
      accountId: this.options.accountId,
      reason,
      reconnectInMs: reconnectDelayMs,
      reconnectAttempts: this.reconnectAttempts,
    });
    this.emit(
      "status",
      this.buildDegradedStatus(reason, {
        reconnectScheduled: true,
        nextReconnectInMs: reconnectDelayMs,
      })
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectAttempts += 1;
      logRuntimeEvent("info", "Attempting relay control-plane reconnect", {
        accountId: this.options.accountId,
        reconnectAttempt: this.reconnectAttempts,
      });
      void this.openSocket({ recovering: true }).catch((error) => {
        if (!isFatalStartupError(error)) {
          return;
        }
        const fatalReason =
          error instanceof Error ? error.message : "Relay reconnect failed fatally";
        logRuntimeEvent("error", "Relay control-plane reconnect failed fatally", {
          accountId: this.options.accountId,
          reason: fatalReason,
          reconnectAttempt: this.reconnectAttempts,
        });
        this.lastDisconnectReason = fatalReason;
        this.emit(
          "status",
          this.buildDegradedStatus(fatalReason, {
            recovering: false,
            reconnectScheduled: false,
            nextReconnectInMs: null,
          })
        );
      });
    }, reconnectDelayMs);
  }

  private buildConnectingStatus(
    details: Partial<RelayRecoveryState> = {}
  ): RelayAccountStatus {
    return {
      state: "connecting",
      ...this.buildRecoveryState(details),
    };
  }

  private buildHealthyStatus(
    capabilities?: RelayCapabilitySnapshot
  ): RelayAccountStatus {
    return {
      state: "healthy",
      capabilities: capabilities ?? this.capabilitySnapshot ?? emptyCapabilities(),
      ...this.buildRecoveryState({
        recovering: false,
        reconnectScheduled: false,
        nextReconnectInMs: null,
      }),
    };
  }

  private buildDegradedStatus(
    reason: string,
    details: Partial<RelayRecoveryState> = {}
  ): RelayAccountStatus {
    return {
      state: "degraded",
      reason,
      capabilities: this.capabilitySnapshot,
      ...this.buildRecoveryState({
        recovering: true,
        ...details,
      }),
    };
  }

  private buildStoppedStatus(): RelayAccountStatus {
    return {
      state: "stopped",
      ...this.buildRecoveryState({
        recovering: false,
        reconnectScheduled: false,
        reconnectAttempts: 0,
        nextReconnectInMs: null,
        lastDisconnectReason: null,
        lastCloseCode: null,
        lastCloseReason: null,
      }),
    };
  }

  private buildRecoveryState(details: Partial<RelayRecoveryState> = {}): RelayRecoveryState {
    return {
      recovering: false,
      reconnectScheduled: Boolean(this.reconnectTimer),
      reconnectAttempts: this.reconnectAttempts,
      nextReconnectInMs: this.reconnectTimer ? this.reconnectDelayMs : null,
      lastDisconnectReason: this.lastDisconnectReason,
      lastCloseCode: this.lastCloseCode,
      lastCloseReason: this.lastCloseReason,
      ...details,
    };
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

function emptyCapabilities(): RelayCapabilitySnapshot {
  return {
    coreCapabilities: {},
    optionalCapabilities: {},
    providerCapabilities: {},
    limits: {},
    transport: {
      provider: "unknown",
    },
  };
}

function decodeCloseReason(reasonBuffer: Buffer): string | null {
  const reason = reasonBuffer.toString("utf8").trim();
  return reason.length > 0 ? reason : null;
}

function normalizeCloseCode(code: number): number | null {
  return Number.isFinite(code) && code > 0 ? code : null;
}

function describeDisconnect(input: {
  code: number | null;
  reason: string | null;
  helloResolved: boolean;
}): string {
  const phase = input.helloResolved ? "after hello" : "before hello";
  if (input.code !== null && input.reason) {
    return `Relay socket disconnected ${phase} (code=${input.code}, reason=${input.reason})`;
  }
  if (input.code !== null) {
    return `Relay socket disconnected ${phase} (code=${input.code})`;
  }
  if (input.reason) {
    return `Relay socket disconnected ${phase} (${input.reason})`;
  }
  return `Relay socket disconnected ${phase}`;
}
