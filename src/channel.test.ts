import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { createRelayChannelPlugin } from "./channel.js";
import { parseRelayChannelPluginConfig } from "./config.js";
import { closeAllRelayEventIngressServersForTest } from "./event-ingress.js";
import { RelayFileDataPlane } from "./file-data-plane.js";
import { helloRequestSchema } from "./protocol/control-plane.js";
import { resolveOutboundSessionRoute } from "./outbound-session-route.js";
import { resolveSessionConversation } from "./session-conversation.js";

type MockRelayOptions = {
  capabilities?: {
    coreCapabilities?: Record<string, boolean>;
    optionalCapabilities?: Record<string, boolean>;
    providerCapabilities?: Record<string, boolean>;
    targetCapabilities?: Record<string, Record<string, boolean>>;
  };
  onAction?: (actionFrame: Record<string, any>) => Record<string, unknown>;
};

const servers: Server[] = [];

afterEach(async () => {
  await closeAllRelayEventIngressServersForTest();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        })
    )
  );
});

async function startMockRelay(options: MockRelayOptions = {}) {
  let helloCount = 0;
  const seenActions: Array<Record<string, any>> = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const body = Buffer.concat(chunks).toString("utf8");
    const parsed = body.length > 0 ? (JSON.parse(body) as Record<string, any>) : {};

    if (req.method === "POST" && req.url === "/hello") {
      helloRequestSchema.parse(parsed);
      helloCount += 1;
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          type: "hello",
          protocolVersion: 1,
          role: "local-relay",
          relayInstanceId: "relay-1",
          accountId: parsed.accountId,
          transport: {
            provider: "telegram",
            providerVersion: "bot-api-compatible",
          },
          coreCapabilities: {
            messageSend: true,
            mediaSend: true,
            inboundMessages: true,
            replyTo: true,
            threadRouting: true,
            ...(options.capabilities?.coreCapabilities ?? {}),
          },
          optionalCapabilities: options.capabilities?.optionalCapabilities ?? {},
          providerCapabilities: options.capabilities?.providerCapabilities ?? {},
          targetCapabilities: options.capabilities?.targetCapabilities ?? {},
          limits: {
            maxUploadBytes: 1024,
            maxCaptionBytes: 100,
            maxPollOptions: 3,
          },
          dataPlane: {
            uploadBaseUrl: "http://127.0.0.1:43129/uploads",
            downloadBaseUrl: "http://127.0.0.1:43129/downloads",
          },
        })
      );
      return;
    }

    if (req.method === "POST" && req.url === "/actions") {
      seenActions.push(parsed);
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify(
          options.onAction?.(parsed) ?? {
            type: "event",
            eventType: "transport.action.completed",
            payload: {
              requestId: parsed.requestId,
              actionId: parsed.action?.actionId,
              result: {
                transportMessageId: "mock-1",
              },
            },
          }
        )
      );
      return;
    }

    res.statusCode = 404;
    res.end();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to get mock relay address");
  }

  return {
    port: address.port,
    seenActions,
    getConnectionCount: () => helloCount,
    publishEvent: async (event: Record<string, unknown>) => {
      const eventType = String(event.eventType ?? "");
      const path =
        eventType === "transport.message.received"
          ? "/events/message-received"
          : eventType === "transport.capabilities.updated"
            ? "/events/capabilities"
            : eventType.startsWith("transport.account.")
              ? "/events/account-status"
              : "/events/transport-event";
      await fetch(`http://127.0.0.1:${address.port + 2}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(event),
      });
    },
  };
}

describe("relay channel plugin", () => {
  it("parses config and resolves account urls", () => {
    const config = parseRelayChannelPluginConfig({
      port: 9999,
      accounts: [{ id: "a" }],
    });

    expect(config.accounts[0]?.url).toBe("http://127.0.0.1:9999");
  });

  it("parses hello capability negotiation contract", () => {
    const plugin = createRelayChannelPlugin();
    const parsed = plugin.config.parse({
      accounts: [{ id: "default", port: 43129 }],
    });

    expect(parsed.capabilityRequirements?.core).toEqual([]);
    expect(parsed.accounts[0]?.id).toBe("default");
  });

  it("normalizes and resolves targets", () => {
    const plugin = createRelayChannelPlugin();

    expect(plugin.directory.normalizeTarget("  Telegram:Topic:-100#77 ")).toBe(
      "telegram:topic:-100#77"
    );
    expect(plugin.directory.resolveTarget("telegram:topic:-100#77")).toMatchObject({
      kind: "topic",
      threadId: "77",
      transportTarget: {
        channel: "telegram",
        chatId: "-100",
      },
    });
  });

  it("maps session conversation with topic-aware ids", () => {
    expect(
      resolveSessionConversation({
        conversationHandle: "-100123",
        baseConversationId: "-100123",
        parentConversationCandidates: ["-100123"],
        threadId: "77",
      })
    ).toEqual({
      id: "-100123#77",
      conversationHandle: "-100123",
      threadHandle: "77",
      threadId: "77",
      baseConversationId: "-100123",
      parentConversationCandidates: ["-100123"],
    });
  });

  it("builds outbound session routes", () => {
    expect(
      resolveOutboundSessionRoute({
        resolvedTarget: {
          to: "telegram:topic:-100123",
          kind: "topic",
          threadId: "77",
          transportTarget: { channel: "telegram", chatId: "-100123" },
        },
        replyToTransportMessageId: "555",
      })
    ).toEqual({
      conversationHandle: "-100123",
      conversationId: "-100123#77",
      baseConversationId: "-100123",
      threadHandle: "77",
      threadId: "77",
      replyToTransportMessageId: "555",
    });
  });

  it("starts one HTTP runtime per account", async () => {
    const relay = await startMockRelay();
    const plugin = createRelayChannelPlugin({
      config: parseRelayChannelPluginConfig({
        accounts: [{ id: "default", url: `http://127.0.0.1:${relay.port}` }],
      }),
    });

    await plugin.gateway.startAccount("default");
    await plugin.gateway.startAccount("default");
    expect(relay.getConnectionCount()).toBe(1);
  });

  it("maps inbound text messages into canonical conversation routing", async () => {
    const inboundMessages: Array<{ sessionId: string; text?: string | null }> = [];
    const relay = await startMockRelay();

    const plugin = createRelayChannelPlugin({
      config: parseRelayChannelPluginConfig({
        accounts: [{ id: "default", url: `http://127.0.0.1:${relay.port}` }],
      }),
      onInboundMessage(message) {
        inboundMessages.push({ sessionId: message.sessionConversation.id, text: message.text });
      },
    });

    await plugin.gateway.startAccount("default");
    await relay.publishEvent({
      type: "event",
      eventType: "transport.message.received",
      payload: {
        eventId: "evt-1",
        accountId: "default",
        cursor: "106",
        conversation: {
          handle: "-100123",
          baseConversationId: "-100123",
          parentConversationCandidates: ["-100123"],
        },
        thread: { handle: "77", threadId: "77" },
        message: {
          transportMessageId: "2002",
          senderId: "user:555",
          text: "ping",
          attachments: [],
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(inboundMessages).toEqual([{ sessionId: "-100123#77", text: "ping" }]);
  });

  it("emits the expected outbound text action envelope", async () => {
    const relay = await startMockRelay({
      onAction(frame) {
        return {
          type: "event",
          eventType: "transport.action.completed",
          payload: {
            requestId: frame.requestId,
            actionId: frame.action.actionId,
            result: {
              transportMessageId: "1001",
              conversationId: "-100123",
              threadId: "77",
            },
          },
        };
      },
    });

    const plugin = createRelayChannelPlugin({
      config: parseRelayChannelPluginConfig({
        accounts: [{ id: "default", url: `http://127.0.0.1:${relay.port}` }],
      }),
    });

    await plugin.gateway.startAccount("default");
    await plugin.outbound.sendText({
      accountId: "default",
      target: plugin.directory.resolveTarget("telegram:topic:-100123#77"),
      text: "hello",
      replyToTransportMessageId: "987",
    });

    expect(relay.seenActions[0]?.action).toMatchObject({
      kind: "message.send",
      thread: {
        handle: "77",
      },
      reply: {
        replyToTransportMessageId: "987",
      },
      payload: {
        text: "hello",
      },
    });
  });

  it("emits outbound media sends through the same transport action channel", async () => {
    const relay = await startMockRelay({
      onAction(frame) {
        return {
          type: "event",
          eventType: "transport.action.completed",
          payload: {
            requestId: frame.requestId,
            actionId: frame.action.actionId,
            result: {
              transportMessageId: "media-1001",
            },
          },
        };
      },
    });

    const plugin = createRelayChannelPlugin({
      config: parseRelayChannelPluginConfig({
        accounts: [{ id: "default", url: `http://127.0.0.1:${relay.port}` }],
      }),
    });

    await plugin.gateway.startAccount("default");
    await plugin.outbound.sendMedia({
      accountId: "default",
      target: plugin.directory.resolveTarget("telegram:group:-100123"),
      text: "identity",
      mediaUrl: "workspace://proofs/identity.md",
      fileName: "identity.md",
      contentType: "text/markdown",
      forceDocument: true,
    });

    expect(relay.seenActions[0]?.action).toMatchObject({
      kind: "message.send",
      payload: {
        text: "identity",
        mediaUrl: "workspace://proofs/identity.md",
        fileName: "identity.md",
        contentType: "text/markdown",
        forceDocument: true,
      },
    });
  });

  it("dispatches download actions through the negotiated relay channel", async () => {
    const relay = await startMockRelay({
      onAction(frame) {
        return {
          type: "event",
          eventType: "transport.action.completed",
          payload: {
            requestId: frame.requestId,
            actionId: frame.action.actionId,
            result: {
              downloadUrl: "http://127.0.0.1:43129/downloads/download-1",
              token: "download-1",
            },
          },
        };
      },
    });

    const plugin = createRelayChannelPlugin({
      config: parseRelayChannelPluginConfig({
        accounts: [{ id: "default", url: `http://127.0.0.1:${relay.port}` }],
      }),
    });

    await plugin.gateway.startAccount("default");
    const download = await plugin.outbound.requestFileDownload({
      accountId: "default",
      target: plugin.directory.resolveTarget("telegram:group:-100123"),
      fileId: "file-1",
    });

    expect(relay.seenActions[0]?.action).toMatchObject({
      kind: "file.download.request",
      payload: {
        fileId: "file-1",
      },
    });
    expect(download.downloadUrl).toBe("http://127.0.0.1:43129/downloads/download-1");
  });

  it("describes typing and remaining optional message-tool actions", async () => {
    const relay = await startMockRelay({
      capabilities: {
        optionalCapabilities: {
          typing: true,
          fileDownloads: true,
          nativeApprovalDelivery: true,
        },
        targetCapabilities: {
          dm: { typing: false },
          group: { typing: true },
        },
      },
    });

    const plugin = createRelayChannelPlugin({
      config: parseRelayChannelPluginConfig({
        accounts: [{ id: "default", url: `http://127.0.0.1:${relay.port}` }],
      }),
    });
    await plugin.gateway.startAccount("default");

    expect(plugin.actions.describeMessageTool("default", "dm").actions).toEqual([
      "send",
      "download",
      "approval_native_delivery",
    ]);
    expect(plugin.actions.describeMessageTool("default", "group").actions).toEqual([
      "send",
      "typing",
      "download",
      "approval_native_delivery",
    ]);
  });

  it("uses loopback data-plane tokens for file transfer", () => {
    const dataPlane = new RelayFileDataPlane({
      uploadBaseUrl: "http://127.0.0.1:43129/uploads",
      downloadBaseUrl: "http://127.0.0.1:43129/downloads",
    });

    expect(
      dataPlane.createUploadPlan({
        accountId: "default",
        actionId: "act-1",
        token: "upload-1",
        expiresAtMs: Date.now() + 60_000,
      }).uploadUrl
    ).toBe("http://127.0.0.1:43129/uploads/upload-1");
  });

  it("rejects relays missing required core capabilities", async () => {
    const relay = await startMockRelay({
      capabilities: {
        coreCapabilities: {
          replyTo: false,
        },
      },
    });

    const plugin = createRelayChannelPlugin({
      config: parseRelayChannelPluginConfig({
        accounts: [{ id: "default", url: `http://127.0.0.1:${relay.port}` }],
      }),
    });

    await expect(plugin.gateway.startAccount("default")).rejects.toThrow(
      /CAPABILITY_MISSING/
    );
    expect(plugin.status.getAccountStatus("default")).toMatchObject({
      state: "degraded",
      recovering: false,
      reconnectScheduled: false,
      reason: expect.stringMatching(/CAPABILITY_MISSING/),
    });
  });

  it("allows baseline messaging when optional capabilities are absent", async () => {
    const relay = await startMockRelay({
      onAction(frame) {
        return {
          type: "event",
          eventType: "transport.action.completed",
          payload: {
            requestId: frame.requestId,
            actionId: frame.action.actionId,
            result: {
              transportMessageId: "ok-1",
            },
          },
        };
      },
    });

    const plugin = createRelayChannelPlugin({
      config: parseRelayChannelPluginConfig({
        accounts: [{ id: "default", url: `http://127.0.0.1:${relay.port}` }],
      }),
    });

    await plugin.gateway.startAccount("default");
    const result = await plugin.outbound.sendText({
      accountId: "default",
      target: plugin.directory.resolveTarget("telegram:group:-100"),
      text: "baseline",
    });

    expect(result.transportMessageId).toBe("ok-1");
  });

  it("forwards transport-level events beyond inbound messages", async () => {
    const seenEvents: Array<{ eventType: string }> = [];
    const relay = await startMockRelay();

    const plugin = createRelayChannelPlugin({
      config: parseRelayChannelPluginConfig({
        accounts: [{ id: "default", url: `http://127.0.0.1:${relay.port}` }],
      }),
      onTransportEvent(event) {
        seenEvents.push({ eventType: event.eventType });
      },
    });

    await plugin.gateway.startAccount("default");
    await relay.publishEvent({
      type: "event",
      eventType: "transport.typing.updated",
      payload: {
        eventId: "evt-2",
        accountId: "default",
        conversation: {
          handle: "-100123",
        },
        typing: {
          active: true,
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(seenEvents).toEqual([{ eventType: "transport.typing.updated" }]);
  });

  it("keeps security and approvals plugin-owned", async () => {
    const relay = await startMockRelay();
    const plugin = createRelayChannelPlugin({
      config: parseRelayChannelPluginConfig({
        dmSecurityPolicy: {
          mode: "allow_list",
          allowedTargets: ["telegram:dm:user:1"],
        },
        accounts: [{ id: "default", url: `http://127.0.0.1:${relay.port}` }],
      }),
    });
    await plugin.gateway.startAccount("default");

    expect(
      plugin.security.evaluateDirectMessage("default", "telegram:dm:user:2")
    ).toEqual({
      allowed: false,
      reason: "DM target is not present in the allow-list.",
    });

    await expect(
      plugin.approvalCapability.deliverApproval({
        accountId: "default",
        target: "telegram:dm:user:1",
        message: "approve",
      })
    ).rejects.toThrow(/CAPABILITY_MISSING/);
  });
});
