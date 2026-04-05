import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { relayChannelOpenclawPlugin } from "./openclaw-channel-plugin.js";

const cfg = {
  channels: {
    "relay-channel": {
      enabled: true,
      accounts: [{ id: "default", port: 43129 }],
    },
  },
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

function startMockRelay(options?: {
  optionalCapabilities?: Record<string, boolean>;
  providerCapabilities?: Record<string, boolean>;
  onAction?: (
    frame: {
      type: "request";
      requestType: "transport.action";
      requestId: string;
      action: {
        actionId: string;
        kind: string;
        payload: Record<string, unknown>;
        transportTarget?: { channel?: string; chatId?: string };
      };
    },
    ws: Parameters<NonNullable<WebSocketServer["clients"]["values"]>["next"]>[0]
  ) => void;
}) {
  const wss = new WebSocketServer({ port: 0 });
  servers.push(wss);
  wss.on("connection", (ws) => {
    ws.on("message", (raw) => {
      const frame = JSON.parse(raw.toString()) as {
        type?: string;
        accountId?: string;
        requestType?: string;
        requestId?: string;
        action?: {
          actionId?: string;
          kind?: string;
          payload?: Record<string, unknown>;
          transportTarget?: { channel?: string; chatId?: string };
        };
      };
      if (frame.type === "hello") {
        ws.send(
          JSON.stringify({
            type: "hello",
            protocolVersion: 1,
            role: "local-relay",
            relayInstanceId: "relay-1",
            accountId: frame.accountId ?? "default",
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
            },
            optionalCapabilities: {
              fileDownloads: true,
              ...(options?.optionalCapabilities ?? {}),
            },
            providerCapabilities: options?.providerCapabilities ?? {},
            limits: {},
            dataPlane: {
              uploadBaseUrl: "http://127.0.0.1:43129/uploads",
              downloadBaseUrl: "http://127.0.0.1:43129/downloads",
            },
          })
        );
        return;
      }
      if (frame.type === "request" && frame.requestType === "transport.action" && frame.requestId && frame.action) {
        options?.onAction?.(
          frame as {
            type: "request";
            requestType: "transport.action";
            requestId: string;
            action: {
              actionId: string;
              kind: string;
              payload: Record<string, unknown>;
              transportTarget?: { channel?: string; chatId?: string };
            };
          },
          ws
        );
      }
    });
  });

  const address = wss.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to get mock relay address");
  }
  return address.port;
}

async function waitForHealthy(cfg: typeof cfg | Record<string, unknown>, accountId = "default") {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const snapshot = relayChannelOpenclawPlugin.status!.buildAccountSnapshot({
      cfg: cfg as never,
      account: { accountId } as never,
    } as never);
    if (snapshot.healthState === "healthy") {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${accountId} relay runtime to become healthy`);
}

describe("relayChannelOpenclawPlugin", () => {
  it("resolves explicit relay targets through messaging fallback", async () => {
    const resolved = await relayChannelOpenclawPlugin.messaging?.targetResolver?.resolveTarget?.({
      cfg,
      accountId: "default",
      input: "telegram:group:-100",
      normalized: "telegram:group:-100",
      preferredKind: "group",
    });

    expect(resolved).toEqual({
      to: "telegram:group:-100",
      kind: "group",
      display: "telegram:group:-100",
      source: "normalized",
    });
  });

  it("supports channels resolve for explicit relay targets", async () => {
    const runtime = {
      log: () => {},
      warn: () => {},
      error: () => {},
      info: () => {},
    };

    const results = await relayChannelOpenclawPlugin.resolver?.resolveTargets({
      cfg,
      accountId: "default",
      inputs: ["telegram:topic:-100#77"],
      kind: "group",
      runtime,
    });

    expect(results).toEqual([
      {
        input: "telegram:topic:-100#77",
        resolved: true,
        id: "telegram:topic:-100",
        name: "telegram:topic:-100#77",
        note: "normalized explicit relay target",
      },
    ]);
  });

  it("keeps the gateway account task alive until abort", async () => {
    const port = startMockRelay();
    const accountId = "gateway-task";
    const runtimeCfg = {
      channels: {
        "relay-channel": {
          enabled: true,
          accounts: [{ id: accountId, url: `ws://127.0.0.1:${port}` }],
        },
      },
    };
    const controller = new AbortController();
    let settled = false;

    const task = relayChannelOpenclawPlugin.gateway!.startAccount({
      cfg: runtimeCfg as never,
      accountId,
      account: { accountId } as never,
      abortSignal: controller.signal,
    } as never);
    task.finally(() => {
      settled = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(settled).toBe(false);

    controller.abort();
    await task;
    expect(settled).toBe(true);

    expect(
      relayChannelOpenclawPlugin.status!.buildAccountSnapshot({
        cfg: runtimeCfg as never,
        account: { accountId } as never,
      } as never)
    ).toMatchObject({
      accountId,
      running: true,
      healthState: "healthy",
    });

    await relayChannelOpenclawPlugin.gateway!.stopAccount({
      cfg: runtimeCfg as never,
      accountId,
      account: { accountId } as never,
    } as never);
  });

  it("routes interactive send payloads through relay message.send with replyMarkup", async () => {
    const seenActions: Array<{
      kind: string;
      payload: Record<string, unknown>;
      transportTarget?: { channel?: string; chatId?: string };
    }> = [];
    const port = startMockRelay({
      optionalCapabilities: {
        "telegram.inlineButtons": true,
      },
      onAction(frame, ws) {
        seenActions.push({
          kind: frame.action.kind,
          payload: frame.action.payload,
          transportTarget: frame.action.transportTarget,
        });
        ws.send(
          JSON.stringify({
            type: "event",
            eventType: "transport.action.completed",
            payload: {
              requestId: frame.requestId,
              actionId: frame.action.actionId,
              result: {
                transportMessageId: "msg-1",
                conversationId: "telegram:123",
              },
            },
          })
        );
      },
    });
    const runtimeCfg = {
      channels: {
        "relay-channel": {
          enabled: true,
          accounts: [{ id: "shared-buttons", url: `ws://127.0.0.1:${port}` }],
        },
      },
    };
    const controller = new AbortController();
    const startTask = relayChannelOpenclawPlugin.gateway!.startAccount({
      cfg: runtimeCfg as never,
      accountId: "shared-buttons",
      account: { accountId: "shared-buttons" } as never,
      abortSignal: controller.signal,
    } as never);

    await waitForHealthy(runtimeCfg, "shared-buttons");

    const description = relayChannelOpenclawPlugin.actions?.describeMessageTool({
      cfg: runtimeCfg as never,
      accountId: "shared-buttons",
    } as never);
    expect(description).toMatchObject({
      capabilities: ["interactive", "buttons"],
      schema: [
        {
          visibility: "all-configured",
          properties: {
            buttons: {
              type: "array",
            },
          },
        },
      ],
    });

    await relayChannelOpenclawPlugin.outbound!.sendPayload?.({
      cfg: runtimeCfg as never,
      to: "telegram:123",
      text: "ignored",
      payload: {
        text: "Choose one",
        interactive: {
          blocks: [
            {
              type: "buttons",
              buttons: [
                { label: "Approve", text: "approve" },
                { label: "Reject", text: "reject" },
              ],
            },
          ],
        },
      },
      accountId: "shared-buttons",
    } as never);

    expect(seenActions[0]).toMatchObject({
      kind: "message.send",
      payload: {
        text: "Choose one",
        replyMarkup: {
          inline_keyboard: [
            [
              { text: "Approve", callback_data: "approve" },
              { text: "Reject", callback_data: "reject" },
            ],
          ],
        },
      },
    });

    controller.abort();
    await startTask;
    await relayChannelOpenclawPlugin.gateway!.stopAccount({
      cfg: runtimeCfg as never,
      accountId: "shared-buttons",
      account: { accountId: "shared-buttons" } as never,
    } as never);
  });

  it("routes shared message-tool buttons through relay message.send with replyMarkup", async () => {
    const seenActions: Array<{
      kind: string;
      payload: Record<string, unknown>;
    }> = [];
    const port = startMockRelay({
      optionalCapabilities: {
        "telegram.inlineButtons": true,
      },
      onAction(frame, ws) {
        seenActions.push({
          kind: frame.action.kind,
          payload: frame.action.payload,
        });
        ws.send(
          JSON.stringify({
            type: "event",
            eventType: "transport.action.completed",
            payload: {
              requestId: frame.requestId,
              actionId: frame.action.actionId,
              result: {
                transportMessageId: "msg-2",
                conversationId: "telegram:123",
              },
            },
          })
        );
      },
    });
    const runtimeCfg = {
      channels: {
        "relay-channel": {
          enabled: true,
          accounts: [{ id: "shared-buttons-raw", url: `ws://127.0.0.1:${port}` }],
        },
      },
    };
    const controller = new AbortController();
    const startTask = relayChannelOpenclawPlugin.gateway!.startAccount({
      cfg: runtimeCfg as never,
      accountId: "shared-buttons-raw",
      account: { accountId: "shared-buttons-raw" } as never,
      abortSignal: controller.signal,
    } as never);

    await waitForHealthy(runtimeCfg, "shared-buttons-raw");

    await relayChannelOpenclawPlugin.outbound!.sendPayload?.({
      cfg: runtimeCfg as never,
      to: "telegram:123",
      text: "ignored",
      payload: {
        text: "Choose one",
        buttons: [
          [
            { text: "Approve", callback_data: "approve" },
            { text: "Reject", callback_data: "reject" },
          ],
        ],
      },
      accountId: "shared-buttons-raw",
    } as never);

    expect(seenActions[0]).toMatchObject({
      kind: "message.send",
      payload: {
        text: "Choose one",
        replyMarkup: {
          inline_keyboard: [
            [
              { text: "Approve", callback_data: "approve" },
              { text: "Reject", callback_data: "reject" },
            ],
          ],
        },
      },
    });

    controller.abort();
    await startTask;
    await relayChannelOpenclawPlugin.gateway!.stopAccount({
      cfg: runtimeCfg as never,
      accountId: "shared-buttons-raw",
      account: { accountId: "shared-buttons-raw" } as never,
    } as never);
  });

  it("normalizes plain targets to the inferred provider before relay send", async () => {
    const seenActions: Array<{
      kind: string;
      payload: Record<string, unknown>;
      transportTarget?: { channel?: string; chatId?: string };
    }> = [];
    const port = startMockRelay({
      optionalCapabilities: {
        "telegram.inlineButtons": true,
      },
      onAction(frame, ws) {
        seenActions.push({
          kind: frame.action.kind,
          payload: frame.action.payload,
          transportTarget: frame.action.transportTarget,
        });
        ws.send(
          JSON.stringify({
            type: "event",
            eventType: "transport.action.completed",
            payload: {
              requestId: frame.requestId,
              actionId: frame.action.actionId,
              result: {
                transportMessageId: "msg-implicit",
                conversationId: "telegram:7278830001",
              },
            },
          })
        );
      },
    });
    const runtimeCfg = {
      channels: {
        "relay-channel": {
          enabled: true,
          accounts: [{ id: "implicit-targets", url: `ws://127.0.0.1:${port}` }],
        },
      },
    };
    const controller = new AbortController();
    const startTask = relayChannelOpenclawPlugin.gateway!.startAccount({
      cfg: runtimeCfg as never,
      accountId: "implicit-targets",
      account: { accountId: "implicit-targets" } as never,
      abortSignal: controller.signal,
    } as never);

    await waitForHealthy(runtimeCfg, "implicit-targets");

    await relayChannelOpenclawPlugin.outbound!.sendText?.({
      cfg: runtimeCfg as never,
      to: "7278830001",
      text: "hello",
      accountId: "implicit-targets",
    } as never);

    expect(seenActions[0]).toMatchObject({
      kind: "message.send",
      payload: {
        text: "hello",
      },
      transportTarget: {
        channel: "telegram",
        chatId: "7278830001",
      },
    });

    controller.abort();
    await startTask;
    await relayChannelOpenclawPlugin.gateway!.stopAccount({
      cfg: runtimeCfg as never,
      accountId: "implicit-targets",
      account: { accountId: "implicit-targets" } as never,
    } as never);
  });

  it("executes poll, edit, and delete actions through relay transport", async () => {
    const seenActions: Array<{ kind: string; payload: Record<string, unknown> }> = [];
    const port = startMockRelay({
      optionalCapabilities: {
        polls: true,
        messageEdit: true,
        messageDelete: true,
      },
      onAction(frame, ws) {
        seenActions.push({
          kind: frame.action.kind,
          payload: frame.action.payload,
        });
        ws.send(
          JSON.stringify({
            type: "event",
            eventType: "transport.action.completed",
            payload: {
              requestId: frame.requestId,
              actionId: frame.action.actionId,
              result: {
                transportMessageId: "ok-1",
                conversationId: "telegram:123",
              },
            },
          })
        );
      },
    });
    const runtimeCfg = {
      channels: {
        "relay-channel": {
          enabled: true,
          accounts: [{ id: "actions", url: `ws://127.0.0.1:${port}` }],
        },
      },
    };
    const controller = new AbortController();
    const startTask = relayChannelOpenclawPlugin.gateway!.startAccount({
      cfg: runtimeCfg as never,
      accountId: "actions",
      account: { accountId: "actions" } as never,
      abortSignal: controller.signal,
    } as never);
    await waitForHealthy(runtimeCfg, "actions");

    await relayChannelOpenclawPlugin.actions!.handleAction?.({
      channel: "relay-channel",
      action: "poll",
      cfg: runtimeCfg as never,
      params: {
        target: "gateway-client",
        channel: "telegram",
        pollQuestion: "Gateway poll?",
        pollOption: ["yes", "no"],
      },
      accountId: "actions",
      toolContext: {
        currentChannelId: "123",
        currentChannelProvider: "telegram",
      },
    } as never);
    await relayChannelOpenclawPlugin.actions!.handleAction?.({
      channel: "relay-channel",
      action: "edit",
      cfg: runtimeCfg as never,
      params: {
        to: "telegram:123",
        messageId: "msg-42",
        message: "updated text",
      },
      accountId: "actions",
    } as never);
    await relayChannelOpenclawPlugin.actions!.handleAction?.({
      channel: "relay-channel",
      action: "delete",
      cfg: runtimeCfg as never,
      params: {
        to: "telegram:123",
        messageId: "msg-42",
      },
      accountId: "actions",
    } as never);

    expect(seenActions).toEqual([
      {
        kind: "poll.send",
        payload: {
          question: "Gateway poll?",
          options: ["yes", "no"],
        },
      },
      {
        kind: "message.edit",
        payload: {
          transportMessageId: "msg-42",
          text: "updated text",
        },
      },
      {
        kind: "message.delete",
        payload: {
          transportMessageId: "msg-42",
        },
      },
    ]);

    controller.abort();
    await startTask;
    await relayChannelOpenclawPlugin.gateway!.stopAccount({
      cfg: runtimeCfg as never,
      accountId: "actions",
      account: { accountId: "actions" } as never,
    } as never);
  });
});
