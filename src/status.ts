import type { RelayAccountStatus, RelayCapabilitySnapshot } from "../api.js";

export class RelayStatusRegistry {
  private readonly statuses = new Map<string, RelayAccountStatus>();

  public setConnecting(accountId: string) {
    this.statuses.set(accountId, { state: "connecting" });
  }

  public setHealthy(accountId: string, capabilities: RelayCapabilitySnapshot) {
    this.statuses.set(accountId, { state: "healthy", capabilities });
  }

  public setDegraded(
    accountId: string,
    reason: string,
    capabilities?: RelayCapabilitySnapshot
  ) {
    this.statuses.set(accountId, { state: "degraded", reason, capabilities });
  }

  public setStopped(accountId: string) {
    this.statuses.set(accountId, { state: "stopped" });
  }

  public get(accountId: string): RelayAccountStatus {
    return this.statuses.get(accountId) ?? { state: "stopped" };
  }

  public list(): Record<string, RelayAccountStatus> {
    return Object.fromEntries(this.statuses.entries());
  }
}
