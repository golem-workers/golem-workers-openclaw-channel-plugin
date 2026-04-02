import type {
  RelayActionRecord,
  RelayCapabilitySnapshot,
} from "../api.js";

type MessageCorrelation = {
  transportMessageId: string;
  sessionKey: string;
};

type AccountPersistenceState = {
  replayCursor?: string;
  capabilitySnapshot?: RelayCapabilitySnapshot;
};

export class InMemoryPersistence {
  private readonly accountState = new Map<string, AccountPersistenceState>();
  private readonly threadBindings = new Map<string, string>();
  private readonly messageCorrelations = new Map<string, MessageCorrelation>();
  private readonly actionRecords = new Map<string, RelayActionRecord>();

  public getReplayCursor(accountId: string): string | undefined {
    return this.accountState.get(accountId)?.replayCursor;
  }

  public setReplayCursor(accountId: string, cursor: string) {
    const current = this.accountState.get(accountId) ?? {};
    this.accountState.set(accountId, { ...current, replayCursor: cursor });
  }

  public getCapabilitySnapshot(accountId: string): RelayCapabilitySnapshot | undefined {
    return this.accountState.get(accountId)?.capabilitySnapshot;
  }

  public setCapabilitySnapshot(accountId: string, snapshot: RelayCapabilitySnapshot) {
    const current = this.accountState.get(accountId) ?? {};
    this.accountState.set(accountId, { ...current, capabilitySnapshot: snapshot });
  }

  public getThreadBinding(sessionKey: string): string | undefined {
    return this.threadBindings.get(sessionKey);
  }

  public setThreadBinding(sessionKey: string, threadId: string) {
    this.threadBindings.set(sessionKey, threadId);
  }

  public setMessageCorrelation(key: string, value: MessageCorrelation) {
    this.messageCorrelations.set(key, value);
  }

  public getMessageCorrelation(key: string): MessageCorrelation | undefined {
    return this.messageCorrelations.get(key);
  }

  public setActionRecord(record: RelayActionRecord) {
    this.actionRecords.set(record.actionId, record);
  }

  public getActionRecord(actionId: string): RelayActionRecord | undefined {
    return this.actionRecords.get(actionId);
  }

  public pruneActionRecords(nowMs: number, retentionMs: number) {
    for (const [actionId, record] of this.actionRecords.entries()) {
      if (record.acceptedAtMs + retentionMs < nowMs) {
        this.actionRecords.delete(actionId);
      }
    }
  }
}
