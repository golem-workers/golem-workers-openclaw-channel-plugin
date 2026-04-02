import { InMemoryPersistence } from "./persistence.js";

export class ThreadBindingStore {
  public constructor(private readonly persistence: InMemoryPersistence) {}

  public remember(sessionKey: string, threadId: string) {
    this.persistence.setThreadBinding(sessionKey, threadId);
  }

  public resolve(sessionKey: string): string | undefined {
    return this.persistence.getThreadBinding(sessionKey);
  }
}
