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
  healthcheckIntervalMs?: number;
};

const DEFAULT_HEALTHCHECK_INTERVAL_MS = 10_000;

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
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private healthcheckTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private connectionHealthy = false;
  private readonly deliveryEvidenceByKey = new Map<string, DeliveryEvidenceContext>();

  public constructor(private readonly options: RelayClientOptions) {
    super();
  }

  public async start(): Promise<RelayCapabilitySnapshot | undefined> {
    this.started = true;
    this.clearReconnectTimer();
    this.clearHealthcheckTimer();
    this.reconnectAttempts = 0;
    return await this.performHello({
      reason: "startup",
      recovering: false,
      emitConnecting: true,
      logAttempt: true,
    });
  }

  public async stop(): Promise<void> {
    this.started = false;
    this.connectionHealthy = false;
    this.clearReconnectTimer();
    this.clearHealthcheckTimer();
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
    this.rememberDeliveryEvidenceContext({ requestId, action });
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
        this.markConnectionHealthy();
        return parsed.payload.result;
      }
      if (parsed.eventType === "transport.action.failed") {
        throw new Error(`${parsed.payload.error.code}: ${parsed.payload.error.message}`);
      }
      if (parsed.eventType === "transport.protocol.error") {
        throw new Error(`${parsed.payload.code}: ${parsed.payload.message}`);
      }
      this.markConnectionHealthy();
      throw new Error(`Unexpected relay action response: ${parsed.eventType}`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.lastDisconnectReason = reason;
      this.lastCloseCode = null;
      this.lastCloseReason = null;
      this.scheduleReconnect(reason);
      throw error;
    }
  }

  public async reconcileAction(input: {
    provider?: string;
    actionId?: string;
    idempotencyKey?: string;
  }): Promise<
    | { status: "sent"; messageId?: string; receipt: RelayActionSuccess }
    | { status: "not_sent" }
    | { status: "unresolved"; retryable: boolean; error: string }
  > {
    if (!this.started) {
      throw new Error("ACCOUNT_NOT_READY: account runtime has not been started");
    }
    const response = await fetchWithTimeout(`${this.options.url}/actions/reconcile`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }, this.options.requestTimeoutMs);
    const json = (await response.json()) as unknown;
    if (!response.ok) {
      throw new Error(`Relay reconcile failed: ${JSON.stringify(json)}`);
    }
    if (isRelayReconcileResult(json)) {
      return json;
    }
    throw new Error(`Unexpected relay reconcile response: ${JSON.stringify(json)}`);
  }

  public getAccountId(): string {
    return this.options.accountId;
  }

  public ingestEvent(rawEvent: Record<string, unknown>) {
    const event = this.enrichControlPlaneEvent(controlPlaneEventSchema.parse(rawEvent));
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
        this.markConnectionHealthy(event.payload);
        break;
      case "transport.protocol.error":
        this.lastDisconnectReason = `${event.payload.code}: ${event.payload.message}`;
        this.emit("protocolError", new Error(this.lastDisconnectReason));
        this.scheduleReconnect(this.lastDisconnectReason);
        break;
      default:
        break;
    }
  }

  private rememberDeliveryEvidenceContext(input: { requestId: string; action: RelayActionPayload }) {
    if (input.action.kind !== "message.send") return;
    const context = buildDeliveryEvidenceContext(input);
    const keys = [
      input.requestId,
      input.action.actionId,
      input.action.idempotencyKey,
    ].filter((key): key is string => typeof key === "string" && key.length > 0);
    for (const key of keys) {
      this.deliveryEvidenceByKey.set(key, context);
    }
    while (this.deliveryEvidenceByKey.size > 500) {
      const oldestKey = this.deliveryEvidenceByKey.keys().next().value as string | undefined;
      if (!oldestKey) break;
      this.deliveryEvidenceByKey.delete(oldestKey);
    }
  }

  private enrichControlPlaneEvent(event: ReturnType<typeof controlPlaneEventSchema.parse>) {
    if (event.eventType !== "transport.delivery.receipt") return event;
    const payload = event.payload;
    const evidence =
      readEvidenceContext(this.deliveryEvidenceByKey, payload.actionId) ??
      readEvidenceContext(this.deliveryEvidenceByKey, payload.requestId);
    if (!evidence) return event;
    return {
      ...event,
      payload: {
        ...payload,
        sessionKey: payload.sessionKey ?? evidence.sessionKey,
        runId: payload.runId ?? evidence.runId,
        backendMessageId: payload.backendMessageId ?? evidence.backendMessageId,
        correlationMessageId: payload.correlationMessageId ?? evidence.correlationMessageId,
        deliveryKind: payload.deliveryKind ?? evidence.deliveryKind,
        visibleText: payload.visibleText ?? evidence.visibleText,
        mediaSummary: payload.mediaSummary ?? evidence.mediaSummary,
      },
    };
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

  private async performHello(input: {
    reason: "startup" | "healthcheck" | "reconnect";
    recovering: boolean;
    emitConnecting: boolean;
    logAttempt: boolean;
  }): Promise<RelayCapabilitySnapshot | undefined> {
    if (!this.started) {
      return undefined;
    }
    if (input.emitConnecting) {
      this.emit(
        "status",
        this.buildConnectingStatus({
          recovering: input.recovering,
          reconnectScheduled: false,
          reconnectAttempts: this.reconnectAttempts,
          nextReconnectInMs: null,
        })
      );
    }
    if (input.logAttempt) {
      logRuntimeEvent(
        "info",
        input.reason === "startup" ? "Starting relay HTTP client" : "Reconnecting relay HTTP client",
        {
          accountId: this.options.accountId,
          url: this.options.url,
          reason: input.reason,
          reconnectAttempts: this.reconnectAttempts,
        }
      );
    }
    try {
      const response = await fetchWithTimeout(
        `${this.options.url}/hello`,
        {
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
        },
        this.options.requestTimeoutMs
      );
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
      this.emit("capabilities", snapshot);
      this.markConnectionHealthy(snapshot);
      return snapshot;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.lastDisconnectReason = reason;
      this.lastCloseCode = null;
      this.lastCloseReason = null;
      if (isFatalStartupError(error)) {
        this.connectionHealthy = false;
        this.clearReconnectTimer();
        this.clearHealthcheckTimer();
        this.emit("status", this.buildDegradedStatus(reason, { recovering: false }));
        throw error;
      }
      this.scheduleReconnect(reason);
      return undefined;
    }
  }

  private markConnectionHealthy(capabilities?: RelayCapabilitySnapshot): void {
    const shouldEmitStatus = !this.connectionHealthy;
    this.connectionHealthy = true;
    this.reconnectAttempts = 0;
    this.clearReconnectTimer();
    this.scheduleHealthcheck();
    this.lastDisconnectReason = null;
    this.lastCloseCode = null;
    this.lastCloseReason = null;
    if (shouldEmitStatus) {
      this.emit("status", this.buildHealthyStatus(capabilities));
    }
  }

  private scheduleReconnect(reason: string): void {
    if (!this.started) {
      return;
    }
    this.connectionHealthy = false;
    this.clearHealthcheckTimer();
    if (this.reconnectTimer) {
      return;
    }
    this.reconnectAttempts += 1;
    const delayMs = Math.min(
      this.options.maxReconnectBackoffMs,
      this.options.reconnectBackoffMs * 2 ** Math.max(0, this.reconnectAttempts - 1)
    );
    this.emit(
      "status",
      this.buildDegradedStatus(reason, {
        recovering: true,
        reconnectScheduled: true,
        reconnectAttempts: this.reconnectAttempts,
        nextReconnectInMs: delayMs,
      })
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.performHello({
        reason: "reconnect",
        recovering: true,
        emitConnecting: true,
        logAttempt: true,
      });
    }, delayMs);
  }

  private scheduleHealthcheck(): void {
    if (!this.started) {
      return;
    }
    this.clearHealthcheckTimer();
    this.healthcheckTimer = setTimeout(() => {
      this.healthcheckTimer = null;
      void this.performHello({
        reason: "healthcheck",
        recovering: false,
        emitConnecting: false,
        logAttempt: false,
      });
    }, this.options.healthcheckIntervalMs ?? DEFAULT_HEALTHCHECK_INTERVAL_MS);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private clearHealthcheckTimer(): void {
    if (this.healthcheckTimer) {
      clearTimeout(this.healthcheckTimer);
      this.healthcheckTimer = null;
    }
  }
}

type DeliveryEvidenceContext = {
  sessionKey?: string;
  runId?: string;
  backendMessageId?: string;
  correlationMessageId?: string;
  deliveryKind?: "tool" | "block" | "final";
  visibleText?: string;
  mediaSummary?: string;
};

function buildDeliveryEvidenceContext(input: {
  requestId: string;
  action: RelayActionPayload;
}): DeliveryEvidenceContext {
  const context = input.action.openclawContext ?? {};
  const visibleText = context.visibleText ?? readActionVisibleText(input.action.payload);
  const mediaSummary = context.mediaSummary ?? readActionMediaSummary(input.action.payload);
  return {
    ...(context.sessionKey ? { sessionKey: context.sessionKey } : {}),
    ...(context.runId ? { runId: context.runId } : {}),
    ...(context.backendMessageId ? { backendMessageId: context.backendMessageId } : {}),
    ...(context.correlationMessageId ? { correlationMessageId: context.correlationMessageId } : {}),
    ...(context.deliveryKind ? { deliveryKind: context.deliveryKind } : {}),
    ...(visibleText ? { visibleText } : {}),
    ...(mediaSummary ? { mediaSummary } : {}),
  };
}

function readEvidenceContext(
  map: Map<string, DeliveryEvidenceContext>,
  key: string | undefined
): DeliveryEvidenceContext | null {
  if (!key) return null;
  return map.get(key) ?? null;
}

function readActionVisibleText(payload: RelayActionPayload["payload"]): string | undefined {
  const text = payload.text ?? payload.caption;
  return typeof text === "string" && text.trim().length > 0 ? text.trim() : undefined;
}

function readActionMediaSummary(payload: RelayActionPayload["payload"]): string | undefined {
  if (typeof payload.mediaUrl === "string" && payload.mediaUrl.trim().length > 0) {
    return "1 media attachment";
  }
  if (Array.isArray(payload.mediaUrls)) {
    const count = payload.mediaUrls.filter((value) => typeof value === "string" && value.trim().length > 0).length;
    if (count > 0) return count === 1 ? "1 media attachment" : `${count} media attachments`;
  }
  return undefined;
}

function isRelayReconcileResult(value: unknown): value is
  | { status: "sent"; messageId?: string; receipt: RelayActionSuccess }
  | { status: "not_sent" }
  | { status: "unresolved"; retryable: boolean; error: string } {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (record.status === "not_sent") {
    return true;
  }
  if (record.status === "unresolved") {
    return typeof record.retryable === "boolean" && typeof record.error === "string";
  }
  if (record.status === "sent") {
    return Boolean(record.receipt && typeof record.receipt === "object");
  }
  return false;
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
