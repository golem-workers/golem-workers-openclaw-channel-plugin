export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type RelayCapabilitySnapshot = {
  coreCapabilities: Record<string, boolean>;
  optionalCapabilities: Record<string, boolean>;
  providerCapabilities: Record<string, boolean>;
  targetCapabilities?: Record<string, Record<string, boolean>>;
  limits: {
    maxUploadBytes?: number;
    maxCaptionBytes?: number;
    maxPollOptions?: number;
  };
  transport: {
    provider: string;
    providerVersion?: string;
  };
};

export type RelayAccountStatus =
  | { state: "connecting" }
  | { state: "healthy"; capabilities: RelayCapabilitySnapshot }
  | { state: "degraded"; reason: string; capabilities?: RelayCapabilitySnapshot }
  | { state: "stopped" };

export type RelaySessionConversation = {
  id: string;
  threadId?: string | null;
  baseConversationId?: string | null;
  parentConversationCandidates?: string[];
};

export type RelayTargetScope = "dm" | "group" | "topic";

export type RelayResolvedTarget = {
  to: string;
  kind: RelayTargetScope;
  display?: string;
  threadId?: string | null;
  transportTarget: Record<string, string>;
};

export type RelayActionKind =
  | "message.send"
  | "message.edit"
  | "message.delete"
  | "reaction.set"
  | "typing.set"
  | "poll.send"
  | "message.pin"
  | "message.unpin"
  | "topic.create"
  | "topic.edit"
  | "topic.close"
  | "callback.answer"
  | "file.download.request";

export type RelayActionPayload = {
  actionId: string;
  kind: RelayActionKind;
  idempotencyKey: string;
  accountId: string;
  targetScope: RelayTargetScope;
  transportTarget: Record<string, string>;
  conversation: {
    transportConversationId: string;
    baseConversationId?: string | null;
    parentConversationCandidates?: string[];
  };
  thread?: {
    threadId?: string | null;
  };
  reply?: {
    replyToTransportMessageId?: string | null;
  };
  payload: Record<string, JsonValue>;
  openclawContext?: {
    sessionKey?: string;
    runId?: string;
  };
};

export type RelayActionSuccess = {
  transportMessageId?: string;
  conversationId?: string;
  threadId?: string;
  uploadUrl?: string;
  downloadUrl?: string;
  token?: string;
};

export type RelayActionFailure = {
  code: string;
  message: string;
  retryable: boolean;
  retryAfterMs?: number;
};

export type RelayActionRecord = {
  actionId: string;
  accountId: string;
  idempotencyKey: string;
  acceptedAtMs: number;
  terminalState?: "completed" | "failed" | "timed_out";
  cursor?: string | null;
};

export type RelayChannelPluginConfig = {
  enabled?: boolean;
  url?: string;
  port?: number;
  reconnectBackoffMs?: number;
  maxReconnectBackoffMs?: number;
  requestTimeoutMs?: number;
  capabilityRequirements?: {
    core?: string[];
    optional?: string[];
  };
  dmSecurityPolicy?: {
    mode?: "allow_all" | "allow_list";
    allowedTargets?: string[];
  };
  pairing?: {
    mode?: "same_chat_only" | "disabled";
    approvalRequired?: boolean;
  };
  directory?: {
    enabled?: boolean;
  };
  accounts: Array<{
    id: string;
    url?: string;
    port?: number;
    metadata?: Record<string, JsonValue>;
  }>;
};

export type RelaySetupInspection = {
  ok: boolean;
  warnings: string[];
  resolvedAccounts: string[];
};

export type RelaySecurityDecision = {
  allowed: boolean;
  reason?: string;
};

export type RelayApprovalRequest = {
  accountId: string;
  target: string;
  message: string;
};

export type RelayApprovalResult = {
  deliveredNatively: boolean;
  capabilityRequired: "nativeApprovalDelivery";
};

export type RelayMessageToolDescription = {
  actions: string[];
};

export type RelayInboundMessageEvent = {
  accountId: string;
  cursor?: string;
  sessionConversation: RelaySessionConversation;
  targetScope: RelayTargetScope;
  senderId: string;
  text?: string | null;
  transportMessageId: string;
  replyToTransportMessageId?: string | null;
  attachments?: Array<Record<string, JsonValue>>;
};

export type RelayTransportEvent = {
  type: "event";
  eventType:
    | "transport.message.edited"
    | "transport.message.deleted"
    | "transport.reaction.updated"
    | "transport.callback.received"
    | "transport.poll.updated"
    | "transport.topic.updated"
    | "transport.delivery.receipt"
    | "transport.typing.updated";
  payload: Record<string, JsonValue>;
};

export type RelayGatewayStartResult = {
  accountId: string;
  status: RelayAccountStatus;
};

export type RelayGatewayStopResult = {
  accountId: string;
  status: RelayAccountStatus;
};

export type ChatChannelPlugin = {
  id: string;
  config: {
    parse(input: unknown): RelayChannelPluginConfig;
  };
  setup: {
    inspect(input: RelayChannelPluginConfig): RelaySetupInspection;
  };
  status: {
    getAccountStatus(accountId: string): RelayAccountStatus;
    listAccounts(): Record<string, RelayAccountStatus>;
  };
  security: {
    evaluateDirectMessage(accountId: string, target: string): RelaySecurityDecision;
  };
  pairing: {
    canPair(accountId: string, target: string): boolean;
  };
  approvalCapability: {
    deliverApproval(request: RelayApprovalRequest): Promise<RelayApprovalResult>;
  };
  gateway: {
    startAccount(accountId: string): Promise<RelayGatewayStartResult>;
    stopAccount(accountId: string): Promise<RelayGatewayStopResult>;
  };
  messaging: {
    resolveSessionConversation(input: {
      targetScope: RelayTargetScope;
      transportConversationId: string;
      baseConversationId?: string | null;
      parentConversationCandidates?: string[];
      threadId?: string | null;
    }): RelaySessionConversation;
    resolveOutboundSessionRoute(input: {
      resolvedTarget: RelayResolvedTarget;
      replyToTransportMessageId?: string | null;
      explicitThreadId?: string | null;
    }): {
      targetScope: RelayTargetScope;
      conversationId: string;
      baseConversationId: string;
      threadId?: string | null;
      replyToTransportMessageId?: string | null;
    };
  };
  actions: {
    describeMessageTool(accountId: string, scope?: RelayTargetScope): RelayMessageToolDescription;
  };
  outbound: {
    sendText(input: {
      accountId: string;
      target: RelayResolvedTarget;
      text: string;
      replyToTransportMessageId?: string | null;
      sessionKey?: string;
      idempotencyKey?: string;
    }): Promise<RelayActionSuccess>;
    sendMedia(input: {
      accountId: string;
      target: RelayResolvedTarget;
      text?: string;
      mediaUrl: string;
      fileName?: string;
      contentType?: string;
      asVoice?: boolean;
      forceDocument?: boolean;
      replyToTransportMessageId?: string | null;
      sessionKey?: string;
      idempotencyKey?: string;
    }): Promise<RelayActionSuccess>;
    editMessage(input: {
      accountId: string;
      target: RelayResolvedTarget;
      transportMessageId: string;
      text?: string;
      caption?: string;
      parseMode?: TelegramParseModeLike;
      replyMarkup?: Record<string, JsonValue>;
      idempotencyKey?: string;
    }): Promise<RelayActionSuccess>;
    deleteMessage(input: {
      accountId: string;
      target: RelayResolvedTarget;
      transportMessageId: string;
      idempotencyKey?: string;
    }): Promise<RelayActionSuccess>;
    setReaction(input: {
      accountId: string;
      target: RelayResolvedTarget;
      transportMessageId: string;
      emojis: string[];
      idempotencyKey?: string;
    }): Promise<RelayActionSuccess>;
    setTyping(input: {
      accountId: string;
      target: RelayResolvedTarget;
      enabled?: boolean;
      chatAction?: string;
      idempotencyKey?: string;
    }): Promise<RelayActionSuccess>;
    sendPoll(input: {
      accountId: string;
      target: RelayResolvedTarget;
      question: string;
      options: string[];
      idempotencyKey?: string;
    }): Promise<RelayActionSuccess>;
    pinMessage(input: {
      accountId: string;
      target: RelayResolvedTarget;
      transportMessageId: string;
      disableNotification?: boolean;
      idempotencyKey?: string;
    }): Promise<RelayActionSuccess>;
    unpinMessage(input: {
      accountId: string;
      target: RelayResolvedTarget;
      transportMessageId?: string;
      idempotencyKey?: string;
    }): Promise<RelayActionSuccess>;
    createTopic(input: {
      accountId: string;
      target: RelayResolvedTarget;
      name: string;
      idempotencyKey?: string;
    }): Promise<RelayActionSuccess>;
    editTopic(input: {
      accountId: string;
      target: RelayResolvedTarget;
      threadId: string;
      name?: string;
      idempotencyKey?: string;
    }): Promise<RelayActionSuccess>;
    closeTopic(input: {
      accountId: string;
      target: RelayResolvedTarget;
      threadId: string;
      idempotencyKey?: string;
    }): Promise<RelayActionSuccess>;
    answerCallback(input: {
      accountId: string;
      target: RelayResolvedTarget;
      callbackQueryId: string;
      text?: string;
      showAlert?: boolean;
      idempotencyKey?: string;
    }): Promise<RelayActionSuccess>;
    requestFileDownload(input: {
      accountId: string;
      target: RelayResolvedTarget;
      fileId: string;
      idempotencyKey?: string;
    }): Promise<RelayActionSuccess>;
  };
  directory: {
    normalizeTarget(input: string): string;
    formatTargetDisplay(input: RelayResolvedTarget): string;
    resolveTarget(input: string): RelayResolvedTarget;
  };
};

export type ChatChannelPluginEntry = {
  id: string;
  create(): ChatChannelPlugin;
};

export function createChatChannelPlugin(plugin: ChatChannelPlugin): ChatChannelPlugin {
  return plugin;
}

export function defineChannelPluginEntry(entry: ChatChannelPluginEntry): ChatChannelPluginEntry {
  return entry;
}

type TelegramParseModeLike = "HTML" | "MarkdownV2" | "Markdown";
