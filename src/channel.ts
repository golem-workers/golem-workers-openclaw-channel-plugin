import {
  createChatChannelPlugin,
  type ChatChannelPlugin,
  type RelayChannelPluginConfig,
  type RelayTransportEvent,
} from "../api.js";
import { deliverApproval } from "./approval.js";
import { RelayAccountRuntime } from "./account-runtime.js";
import { parseRelayChannelPluginConfig } from "./config.js";
import { describeMessageTool } from "./message-actions.js";
import { resolveOutboundSessionRoute } from "./outbound-session-route.js";
import { canPairTarget } from "./pairing.js";
import { evaluateDirectMessageSecurity } from "./security.js";
import { resolveSessionConversation } from "./session-conversation.js";
import { inspectRelaySetup } from "./setup.js";
import { RelayStatusRegistry } from "./status.js";
import {
  formatTargetDisplay,
  normalizeTarget,
  resolveTarget,
} from "./target-resolution.js";

export type CreateRelayChannelPluginOptions = {
  config?: RelayChannelPluginConfig;
  onInboundMessage?: (message: {
    accountId: string;
    cursor?: string;
    sessionConversation: {
      id: string;
      conversationHandle?: string;
      threadHandle?: string | null;
      threadId?: string | null;
      baseConversationId?: string | null;
      parentConversationCandidates?: string[];
    };
    senderId: string;
    text?: string | null;
    transportMessageId: string;
    replyToTransportMessageId?: string | null;
    attachments?: Array<Record<string, unknown>>;
  }) => void;
  onTransportEvent?: (event: RelayTransportEvent) => void;
};

export function createRelayChannelPlugin(
  options: CreateRelayChannelPluginOptions = {}
): ChatChannelPlugin {
  const statusRegistry = new RelayStatusRegistry();
  let currentConfig =
    options.config ??
    parseRelayChannelPluginConfig({
      enabled: true,
      accounts: [{ id: "default", port: 43129 }],
    });

  const runtimes = new Map<string, RelayAccountRuntime>();

  const getRuntime = (accountId: string) => {
    const existing = runtimes.get(accountId);
    if (existing) {
      return existing;
    }
    const runtime = new RelayAccountRuntime(
      currentConfig,
      accountId,
      statusRegistry,
      options.onInboundMessage,
      options.onTransportEvent
    );
    runtimes.set(accountId, runtime);
    return runtime;
  };

  return createChatChannelPlugin({
    id: "relay-channel",
    config: {
      parse(input) {
        currentConfig = parseRelayChannelPluginConfig(input);
        return currentConfig;
      },
    },
    setup: {
      inspect(input) {
        return inspectRelaySetup(input);
      },
    },
    status: {
      getAccountStatus(accountId) {
        return statusRegistry.get(accountId);
      },
      listAccounts() {
        return statusRegistry.list();
      },
    },
    security: {
      evaluateDirectMessage(_accountId, target) {
        return evaluateDirectMessageSecurity(currentConfig, target);
      },
    },
    pairing: {
      canPair(_accountId, target) {
        return canPairTarget(currentConfig, target);
      },
    },
    approvalCapability: {
      async deliverApproval(request) {
        const runtime = getRuntime(request.accountId);
        return await deliverApproval(request, runtime.getCapabilitySnapshot());
      },
    },
    gateway: {
      async startAccount(accountId) {
        const runtime = getRuntime(accountId);
        const status = await runtime.start();
        return { accountId, status };
      },
      async stopAccount(accountId) {
        const runtime = getRuntime(accountId);
        const status = await runtime.stop();
        return { accountId, status };
      },
    },
    messaging: {
      resolveSessionConversation(input) {
        return resolveSessionConversation(input);
      },
      resolveOutboundSessionRoute(input) {
        return resolveOutboundSessionRoute(input);
      },
    },
    actions: {
      describeMessageTool(accountId, scope) {
        const runtime = getRuntime(accountId);
        return describeMessageTool(runtime.getCapabilitySnapshot(), scope);
      },
    },
    outbound: {
      async sendText(input) {
        const runtime = getRuntime(input.accountId);
        return await runtime.sendAction({
          kind: "message.send",
          target: input.target,
          payload: {
            text: input.text,
          },
          replyToTransportMessageId: input.replyToTransportMessageId,
          sessionKey: input.sessionKey,
          idempotencyKey: input.idempotencyKey,
        });
      },
      async sendMedia(input) {
        const runtime = getRuntime(input.accountId);
        return await runtime.sendAction({
          kind: "message.send",
          target: input.target,
          payload: {
            ...(input.text ? { text: input.text } : {}),
            mediaUrl: input.mediaUrl,
            ...(input.fileName ? { fileName: input.fileName } : {}),
            ...(input.contentType ? { contentType: input.contentType } : {}),
            ...(input.asVoice === true ? { asVoice: true } : {}),
            ...(input.forceDocument === true ? { forceDocument: true } : {}),
          },
          replyToTransportMessageId: input.replyToTransportMessageId,
          sessionKey: input.sessionKey,
          idempotencyKey: input.idempotencyKey,
        });
      },
      async editMessage(input) {
        const runtime = getRuntime(input.accountId);
        return await runtime.sendAction({
          kind: "message.edit",
          target: input.target,
          payload: {
            transportMessageId: input.transportMessageId,
            ...(input.text ? { text: input.text } : {}),
            ...(input.caption ? { caption: input.caption } : {}),
            ...(input.parseMode ? { parseMode: input.parseMode } : {}),
            ...(input.replyMarkup ? { replyMarkup: input.replyMarkup } : {}),
          },
          idempotencyKey: input.idempotencyKey,
        });
      },
      async deleteMessage(input) {
        const runtime = getRuntime(input.accountId);
        return await runtime.sendAction({
          kind: "message.delete",
          target: input.target,
          payload: {
            transportMessageId: input.transportMessageId,
          },
          idempotencyKey: input.idempotencyKey,
        });
      },
      async setReaction(input) {
        const runtime = getRuntime(input.accountId);
        return await runtime.sendAction({
          kind: "reaction.set",
          target: input.target,
          payload: {
            transportMessageId: input.transportMessageId,
            emojis: input.emojis,
          },
          idempotencyKey: input.idempotencyKey,
        });
      },
      async setTyping(input) {
        const runtime = getRuntime(input.accountId);
        return await runtime.sendAction({
          kind: "typing.set",
          target: input.target,
          payload: {
            ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
            ...(input.chatAction ? { chatAction: input.chatAction } : {}),
          },
          idempotencyKey: input.idempotencyKey,
        });
      },
      async sendPoll(input) {
        const runtime = getRuntime(input.accountId);
        return await runtime.sendAction({
          kind: "poll.send",
          target: input.target,
          payload: {
            question: input.question,
            options: input.options,
          },
          idempotencyKey: input.idempotencyKey,
        });
      },
      async pinMessage(input) {
        const runtime = getRuntime(input.accountId);
        return await runtime.sendAction({
          kind: "message.pin",
          target: input.target,
          payload: {
            transportMessageId: input.transportMessageId,
            ...(input.disableNotification !== undefined
              ? { disableNotification: input.disableNotification }
              : {}),
          },
          idempotencyKey: input.idempotencyKey,
        });
      },
      async unpinMessage(input) {
        const runtime = getRuntime(input.accountId);
        return await runtime.sendAction({
          kind: "message.unpin",
          target: input.target,
          payload: {
            ...(input.transportMessageId ? { transportMessageId: input.transportMessageId } : {}),
          },
          idempotencyKey: input.idempotencyKey,
        });
      },
      async createTopic(input) {
        const runtime = getRuntime(input.accountId);
        return await runtime.sendAction({
          kind: "topic.create",
          target: input.target,
          payload: {
            name: input.name,
          },
          idempotencyKey: input.idempotencyKey,
        });
      },
      async editTopic(input) {
        const runtime = getRuntime(input.accountId);
        return await runtime.sendAction({
          kind: "topic.edit",
          target: {
            ...input.target,
            threadId: input.threadId,
          },
          payload: {
            threadId: input.threadId,
            ...(input.name ? { name: input.name } : {}),
          },
          explicitThreadId: input.threadId,
          idempotencyKey: input.idempotencyKey,
        });
      },
      async closeTopic(input) {
        const runtime = getRuntime(input.accountId);
        return await runtime.sendAction({
          kind: "topic.close",
          target: {
            ...input.target,
            threadId: input.threadId,
          },
          payload: {
            threadId: input.threadId,
          },
          explicitThreadId: input.threadId,
          idempotencyKey: input.idempotencyKey,
        });
      },
      async answerCallback(input) {
        const runtime = getRuntime(input.accountId);
        return await runtime.sendAction({
          kind: "callback.answer",
          target: input.target,
          payload: {
            callbackQueryId: input.callbackQueryId,
            ...(input.text ? { text: input.text } : {}),
            ...(input.showAlert !== undefined ? { showAlert: input.showAlert } : {}),
          },
          idempotencyKey: input.idempotencyKey,
        });
      },
      async requestFileDownload(input) {
        const runtime = getRuntime(input.accountId);
        return await runtime.sendAction({
          kind: "file.download.request",
          target: input.target,
          payload: {
            fileId: input.fileId,
          },
          idempotencyKey: input.idempotencyKey,
        });
      },
    },
    directory: {
      normalizeTarget,
      formatTargetDisplay,
      resolveTarget,
    },
  });
}
