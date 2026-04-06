import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type {
  RelayAccountStatus,
  RelayActionPayload,
  RelayActionSuccess,
  RelayCapabilitySnapshot,
  RelayRecoveryState,
} from "../api.js";
import {
  controlPlaneEventSchema,
  helloRequestSchema,
  helloResponseSchema,
  transportActionRequestSchema,
} from "./protocol/control-plane.js";
import { logRuntimeEvent } from "./runtime-log.js";
import { REQUIRED_CORE_CAPABILITIES } from "./types.js";

export type RelayClientOptions = {
  accountId: string;
  url: string;
  reconnectBackoffMs: number;
  maxReconnectBackoffMs: number;
  requestTimeoutMs: number;
  requiredCoreCapabilities?: string[];
};

export class RelayClient extends EventEmitter {
  private started = false;
  private capabilitySnapshot?: RelayCapabilitySnapshot;
  private dataPlane?: {
    uploadBaseUrl: string;
    downloadBaseUrl: string;
  };
  private lastDisconnectReason: string | null = null;
  private lastCloseCode: number | null = null;
  private lastCloseReason: string | null = null;

  public constructor(private readonly options: RelayClientOptions) {
    super();
  }

  public async start(): Promise<RelayCapabilitySnapshot | undefined> {
    this.started = true;
    this.emit("status", this.buildConnectingStatus());
    logRuntimeEvent("info", "Starting relay HTTP client", {
      accountId: this.options.accountId,
      url: this.options.url,
    });
    try {
      const response = await fetchWithTimeout(`${this.options.url}/hello`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          helloRequestSchema.parse({
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
          })
        ),
      }, this.options.requestTimeoutMs);
      const hello = helloResponseSchema.parse(await response.json());
      const snapshot: RelayCapabilitySnapshot = {
        coreCapabilities: hello.coreCapabilities,
        optionalCapabilities: hello.optionalCapabilities,
        providerCapabilities: hello.providerCapabilities,
        providerFeatures: hello.providerFeatures,
        providerProfiles: hello.providerProfiles,
        targetCapabilities: hello.targetCapabilities,
        limits: hello.limits,
        transport: hello.transport,
      };
      this.assertRequiredCapabilities(snapshot);
      this.capabilitySnapshot = snapshot;
      this.dataPlane = hello.dataPlane;
      this.lastDisconnectReason = null;
      this.lastCloseCode = null;
      this.lastCloseReason = null;
      this.emit("capabilities", snapshot);
      this.emit("status", this.buildHealthyStatus(snapshot));
      return snapshot;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.lastDisconnectReason = reason;
      this.lastCloseCode = null;
      this.lastCloseReason = null;
      this.emit("status", this.buildDegradedStatus(reason, { recovering: false }));
      if (isFatalStartupError(error)) {
        throw error;
      }
      return undefined;
    }
  }

  public async stop(): Promise<void> {
    this.started = false;
    this.emit("status", this.buildStoppedStatus());
  }

  public getCapabilitySnapshot(): RelayCapabilitySnapshot | undefined {
    return this.capabilitySnapshot;
  }

  public getDataPlane() {
    return this.dataPlane;
  }

  public async dispatchAction(action: RelayActionPayload): Promise<RelayActionSuccess> {
    if (!this.started) {
      throw new Error("ACCOUNT_NOT_READY: account runtime has not been started");
    }
    const requestId = randomUUID();
    try {
      const response = await fetchWithTimeout(`${this.options.url}/actions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          transportActionRequestSchema.parse({
            type: "request",
            requestType: "transport.action",
            requestId,
            action,
          })
        ),
      }, this.options.requestTimeoutMs);
      const json = (await response.json()) as unknown;
      const parsed = controlPlaneEventSchema.parse(json);
      if (parsed.eventType === "transport.action.completed") {
        return parsed.payload.result;
      }
      if (parsed.eventType === "transport.action.failed") {
        throw new Error(`${parsed.payload.error.code}: ${parsed.payload.error.message}`);
      }
      if (parsed.eventType === "transport.protocol.error") {
        throw new Error(`${parsed.payload.code}: ${parsed.payload.message}`);
      }
      throw new Error(`Unexpected relay action response: ${parsed.eventType}`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.lastDisconnectReason = reason;
      this.lastCloseCode = null;
      this.lastCloseReason = null;
      this.emit("status", this.buildDegradedStatus(reason, { recovering: false }));
      throw error;
    }
  }

  public ingestEvent(rawEvent: Record<string, unknown>) {
    const event = controlPlaneEventSchema.parse(rawEvent);
    switch (event.eventType) {
      case "transport.message.received":
        this.emit("inboundMessage", event);
        break;
      case "transport.delivery.receipt":
      case "transport.typing.updated":
        this.emit("transportEvent", event);
        break;
      case "transport.account.connecting":
      case "transport.account.ready":
      case "transport.account.degraded":
      case "transport.account.disconnected":
      case "transport.account.status": {
        if (event.payload.state === "healthy") {
          this.emit("status", this.buildHealthyStatus());
        } else if (event.payload.state === "connecting") {
          this.emit("status", this.buildConnectingStatus());
        } else if (event.payload.state === "stopped") {
          this.emit("status", this.buildStoppedStatus());
        } else {
          this.lastDisconnectReason = event.payload.reason ?? "Relay reported degraded state";
          this.emit("status", this.buildDegradedStatus(this.lastDisconnectReason));
        }
        break;
      }
      case "transport.capabilities.updated":
        this.capabilitySnapshot = event.payload;
        this.emit("capabilities", event.payload);
        this.emit("status", this.buildHealthyStatus(event.payload));
        break;
      case "transport.protocol.error":
        this.lastDisconnectReason = `${event.payload.code}: ${event.payload.message}`;
        this.emit("protocolError", new Error(this.lastDisconnectReason));
        this.emit("status", this.buildDegradedStatus(this.lastDisconnectReason, { recovering: false }));
        break;
      default:
        break;
    }
  }

  private buildConnectingStatus(details: Partial<RelayRecoveryState> = {}): RelayAccountStatus {
    return {
      state: "connecting",
      ...this.buildRecoveryState(details),
    };
  }

  private buildHealthyStatus(capabilities?: RelayCapabilitySnapshot): RelayAccountStatus {
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
        recovering: false,
        reconnectScheduled: false,
        nextReconnectInMs: null,
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
      reconnectScheduled: false,
      reconnectAttempts: 0,
      nextReconnectInMs: null,
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

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP_${response.status}`);
    }
    return response;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("transport action timed out");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
