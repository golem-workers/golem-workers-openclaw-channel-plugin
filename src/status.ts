import type {
  RelayAccountStatus,
  RelayCapabilitySnapshot,
  RelayRecoveryState,
} from "../api.js";

const EMPTY_RECOVERY_STATE: RelayRecoveryState = {
  recovering: false,
  reconnectScheduled: false,
  reconnectAttempts: 0,
  nextReconnectInMs: null,
  lastDisconnectReason: null,
  lastCloseCode: null,
  lastCloseReason: null,
};

function normalizeRecoveryState(
  details?: Partial<RelayRecoveryState>,
  previous?: RelayAccountStatus
): RelayRecoveryState {
  return {
    ...EMPTY_RECOVERY_STATE,
    ...(previous
      ? {
          reconnectAttempts: previous.reconnectAttempts,
          lastDisconnectReason: previous.lastDisconnectReason,
          lastCloseCode: previous.lastCloseCode,
          lastCloseReason: previous.lastCloseReason,
        }
      : {}),
    ...details,
  };
}

export class RelayStatusRegistry {
  private readonly statuses = new Map<string, RelayAccountStatus>();

  public setConnecting(accountId: string, details?: Partial<RelayRecoveryState>) {
    const previous = this.statuses.get(accountId);
    this.statuses.set(accountId, {
      state: "connecting",
      ...normalizeRecoveryState(details, previous),
    });
  }

  public setHealthy(
    accountId: string,
    capabilities: RelayCapabilitySnapshot,
    details?: Partial<RelayRecoveryState>
  ) {
    const previous = this.statuses.get(accountId);
    this.statuses.set(accountId, {
      state: "healthy",
      capabilities,
      ...normalizeRecoveryState(
        {
          recovering: false,
          reconnectScheduled: false,
          nextReconnectInMs: null,
          ...(details ?? {}),
        },
        previous
      ),
    });
  }

  public setDegraded(
    accountId: string,
    reason: string,
    capabilities?: RelayCapabilitySnapshot,
    details?: Partial<RelayRecoveryState>
  ) {
    const previous = this.statuses.get(accountId);
    this.statuses.set(accountId, {
      state: "degraded",
      reason,
      capabilities,
      ...normalizeRecoveryState(
        {
          recovering: true,
          ...(details ?? {}),
        },
        previous
      ),
    });
  }

  public setStopped(accountId: string, details?: Partial<RelayRecoveryState>) {
    this.statuses.set(accountId, {
      state: "stopped",
      ...normalizeRecoveryState(
        {
          recovering: false,
          reconnectScheduled: false,
          nextReconnectInMs: null,
          reconnectAttempts: 0,
          ...(details ?? {}),
        },
        undefined
      ),
    });
  }

  public get(accountId: string): RelayAccountStatus {
    return (
      this.statuses.get(accountId) ?? {
        state: "stopped",
        ...EMPTY_RECOVERY_STATE,
      }
    );
  }

  public list(): Record<string, RelayAccountStatus> {
    return Object.fromEntries(this.statuses.entries());
  }
}
