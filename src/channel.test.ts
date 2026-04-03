import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { createRelayChannelPlugin } from "./channel.js";
import { parseRelayChannelPluginConfig } from "./config.js";
import { RelayFileDataPlane } from "./file-data-plane.js";
import { InMemoryPersistence } from "./persistence.js";
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
  onAction?: (actionFrame: Record<string, any>, ws: import("ws").WebSocket) => void;
  onReplay?: (replayFrame: Record<string, any>, ws: import("ws").WebSocket) => void;
  afterHello?: (ws: import("ws").WebSocket) => void;
};

const servers: WebSocketServer[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          for (const client of server.clients) {
            client.terminate();
          }
          server.close((error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        })
    )
  );
});

function startMockRelay(options: MockRelayOptions = {}) {
  let connectionCount = 0;
  const seenActions: Array<Record<string, any>> = [];
  const wss = new WebSocketServer({ port: 0 });
  servers.push(wss);
  wss.on("connection", (ws) => {
    connectionCount += 1;
    ws.on("message", (raw) => {
      const frame = JSON.parse(raw.toString()) as Record<string, any>;
      if (frame.type === "hello") {
        helloRequestSchema.parse(frame);
        ws.send(
          JSON.stringify({
            type: "hello",
            protocolVersion: 1,
            role: "local-relay",
            relayInstanceId: "relay-1",
            accountId: frame.accountId,
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
            targetCapabilities: options.capabilities?.targetCapabilities ?? {
              dm: { typing: false },
              group: { typing: true, polls: true },
              topic: { "telegram.forumTopics": true },
            },
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
        options.afterHello?.(ws);
        return;
      }
      if (frame.requestType === "transport.action") {
        seenActions.push(frame);
        options.onAction?.(frame, ws);
        return;
      }
      if (frame.requestType === "transport.replay") {
        options.onReplay?.(frame, ws);
      }
    });
  });

  const address = wss.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to get mock relay address");
  }

  return {
    port: address.port,
    seenActions,
    getConnectionCount: () => connectionCount,
    closeConnection() {
      for (const client of wss.clients) {
        client.close();
      }
    },
    reopenHealthy() {
      for (const client of wss.clients) {
        client.send(
          JSON.stringify({
            type: "event",
            eventType: "transport.account.ready",
            payload: {
              accountId: "default",
              state: "healthy",
            },
          })
        );
      }
    },
  };
}

describe("relay channel plugin", () => {
  it("parses config and resolves account urls", () => {
    const config = parseRelayChannelPluginConfig({
      port: 9999,
      accounts: [{ id: "a" }],
    });

    expect(config.accounts[0]?.url).toBe("ws://127.0.0.1:9999");
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
        targetScope: "topic",
        transportConversationId: "-100123",
        baseConversationId: "-100123",
        parentConversationCandidates: ["-100123"],
        threadId: "77",
      })
    ).toEqual({
      id: "-100123:topic:77",
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
      targetScope: "topic",
      conversationId: "-100123:topic:77",
      baseConversationId: "-100123",
      threadId: "77",
      replyToTransportMessageId: "555",
    });
  });

  it("stores replay cursor durably", () => {
    const persistence = new InMemoryPersistence();
    persistence.setReplayCursor("default", "104");

    expect(persistence.getReplayCursor("default")).toBe("104");
  });

  it("suppresses duplicate terminal events", async () => {
    const relay = startMockRelay({
      onAction(frame, ws) {
        ws.send(
          JSON.stringify({
            type: "event",
            eventType: "transport.action.completed",
            payload: {
              requestId: frame.requestId,
              actionId: frame.action.actionId,
              result: {
                transportMessageId: "m1",
              },
            },
          })
        );
        ws.send(
          JSON.stringify({
            type: "event",
            eventType: "transport.action.completed",
            payload: {
              requestId: frame.requestId,
              actionId: frame.action.actionId,
              result: {
                transportMessageId: "m2",
              },
            },
          })
        );
      },
    });

    const plugin = createRelayChannelPlugin({
      config: parseRelayChannelPluginConfig({
        accounts: [{ id: "default", url: `ws://127.0.0.1:${relay.port}` }],
      }),
    });

    await plugin.gateway.startAccount("default");
    const result = await plugin.outbound.sendText({
      accountId: "default",
      target: plugin.directory.resolveTarget("telegram:group:-100"),
      text: "hello",
    });

    expect(result.transportMessageId).toBe("m1");
  });

  it("establishes one runtime per account", async () => {
    const relay = startMockRelay();
    const plugin = createRelayChannelPlugin({
      config: parseRelayChannelPluginConfig({
        accounts: [{ id: "default", url: `ws://127.0.0.1:${relay.port}` }],
      }),
    });

    await plugin.gateway.startAccount("default");
    await plugin.gateway.startAccount("default");

    expect(relay.getConnectionCount()).toBe(1);
  });

  it("transitions through degraded and back to healthy after reconnect", async () => {
    const relay = startMockRelay();
    const plugin = createRelayChannelPlugin({
      config: parseRelayChannelPluginConfig({
        reconnectBackoffMs: 80,
        maxReconnectBackoffMs: 100,
        accounts: [{ id: "default", url: `ws://127.0.0.1:${relay.port}` }],
      }),
    });

    await plugin.gateway.startAccount("default");
    relay.closeConnection();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(plugin.status.getAccountStatus("default").state).toBe("degraded");

    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(plugin.status.getAccountStatus("default").state).toBe("healthy");
  });

  it("maps inbound text messages into canonical conversation routing", async () => {
    const inboundMessages: Array<{ sessionId: string; text?: string | null }> = [];
    const relay = startMockRelay({
      afterHello(ws) {
        setTimeout(() => {
          ws.send(
            JSON.stringify({
              type: "event",
              eventType: "transport.message.received",
              payload: {
                eventId: "evt-1",
                accountId: "default",
                cursor: "106",
                conversation: {
                  transportConversationId: "-100123",
                  baseConversationId: "-100123",
                  parentConversationCandidates: ["-100123"],
                },
                thread: { threadId: "77" },
                message: {
                  transportMessageId: "2002",
                  senderId: "user:555",
                  text: "ping",
                  attachments: [],
                },
              },
            })
          );
        }, 5);
      },
    });

    const plugin = createRelayChannelPlugin({
      config: parseRelayChannelPluginConfig({
        accounts: [{ id: "default", url: `ws://127.0.0.1:${relay.port}` }],
      }),
      onInboundMessage(message) {
        inboundMessages.push({ sessionId: message.sessionConversation.id, text: message.text });
      },
    });

    await plugin.gateway.startAccount("default");
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(inboundMessages).toEqual([{ sessionId: "-100123:topic:77", text: "ping" }]);
  });

  it("emits the expected outbound text action envelope", async () => {
    const relay = startMockRelay({
      onAction(frame, ws) {
        ws.send(
          JSON.stringify({
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
          })
        );
      },
    });

    const plugin = createRelayChannelPlugin({
      config: parseRelayChannelPluginConfig({
        accounts: [{ id: "default", url: `ws://127.0.0.1:${relay.port}` }],
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
      targetScope: "topic",
      thread: {
        threadId: "77",
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
    const relay = startMockRelay({
      onAction(frame, ws) {
        ws.send(
          JSON.stringify({
            type: "event",
            eventType: "transport.action.completed",
            payload: {
              requestId: frame.requestId,
              actionId: frame.action.actionId,
              result: {
                transportMessageId: "media-1001",
              },
            },
          })
        );
      },
    });

    const plugin = createRelayChannelPlugin({
      config: parseRelayChannelPluginConfig({
        accounts: [{ id: "default", url: `ws://127.0.0.1:${relay.port}` }],
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

  it("gates message-tool actions by target capabilities", async () => {
    const relay = startMockRelay({
      capabilities: {
        optionalCapabilities: {
          typing: true,
          polls: true,
          nativeApprovalDelivery: true,
        },
        targetCapabilities: {
          dm: { typing: false },
          group: { typing: true, polls: true },
        },
      },
    });

    const plugin = createRelayChannelPlugin({
      config: parseRelayChannelPluginConfig({
        accounts: [{ id: "default", url: `ws://127.0.0.1:${relay.port}` }],
      }),
    });
    await plugin.gateway.startAccount("default");

    expect(plugin.actions.describeMessageTool("default", "dm").actions).not.toContain("typing");
    expect(plugin.actions.describeMessageTool("default", "group").actions).toContain("typing");
    expect(plugin.actions.describeMessageTool("default", "group").actions).toContain("poll");
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
    const relay = startMockRelay({
      capabilities: {
        coreCapabilities: {
          replyTo: false,
        },
      },
    });

    const plugin = createRelayChannelPlugin({
      config: parseRelayChannelPluginConfig({
        accounts: [{ id: "default", url: `ws://127.0.0.1:${relay.port}` }],
      }),
    });

    await expect(plugin.gateway.startAccount("default")).rejects.toThrow(
      /CAPABILITY_MISSING/
    );
  });

  it("allows baseline messaging when optional capabilities are absent", async () => {
    const relay = startMockRelay({
      onAction(frame, ws) {
        ws.send(
          JSON.stringify({
            type: "event",
            eventType: "transport.action.completed",
            payload: {
              requestId: frame.requestId,
              actionId: frame.action.actionId,
              result: {
                transportMessageId: "ok-1",
              },
            },
          })
        );
      },
    });

    const plugin = createRelayChannelPlugin({
      config: parseRelayChannelPluginConfig({
        accounts: [{ id: "default", url: `ws://127.0.0.1:${relay.port}` }],
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

  it("surfaces replay gaps explicitly", async () => {
    const persistence = new InMemoryPersistence();
    persistence.setReplayCursor("default", "104");
    const relay = startMockRelay({
      onReplay(_frame, ws) {
        ws.send(
          JSON.stringify({
            type: "event",
            eventType: "transport.replay.gap",
            payload: {
              fromCursor: "104",
              toCursor: "121",
              reason: "relay_restart_without_durable_buffer",
            },
          })
        );
      },
    });

    const plugin = createRelayChannelPlugin({
      persistence,
      config: parseRelayChannelPluginConfig({
        accounts: [{ id: "default", url: `ws://127.0.0.1:${relay.port}` }],
      }),
    });

    await plugin.gateway.startAccount("default");
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(plugin.status.getAccountStatus("default")).toMatchObject({
      state: "degraded",
      reason: "Replay gap: relay_restart_without_durable_buffer",
    });
  });

  it("keeps security and approvals plugin-owned", async () => {
    const relay = startMockRelay();
    const plugin = createRelayChannelPlugin({
      config: parseRelayChannelPluginConfig({
        dmSecurityPolicy: {
          mode: "allow_list",
          allowedTargets: ["telegram:dm:user:1"],
        },
        accounts: [{ id: "default", url: `ws://127.0.0.1:${relay.port}` }],
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
