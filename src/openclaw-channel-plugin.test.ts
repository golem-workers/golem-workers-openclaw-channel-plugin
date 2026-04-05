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
  let connectionCount = 0;
  const wss = new WebSocketServer({ port: 0 });
  servers.push(wss);
  wss.on("connection", (ws) => {
    connectionCount += 1;
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
  return {
    port: address.port,
    getConnectionCount: () => connectionCount,
    closeConnection(code?: number, reason?: string) {
      for (const client of wss.clients) {
        client.close(code, reason);
      }
    },
  };
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
    const relay = startMockRelay();
    const accountId = "gateway-task";
    const runtimeCfg = {
      channels: {
        "relay-channel": {
          enabled: true,
          accounts: [{ id: accountId, url: `ws://127.0.0.1:${relay.port}` }],
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
      recovering: false,
      reconnectScheduled: false,
    });

    await relayChannelOpenclawPlugin.gateway!.stopAccount({
      cfg: runtimeCfg as never,
      accountId,
      account: { accountId } as never,
    } as never);
  });

  it("keeps degraded relay runtimes running in account snapshots while reconnect is scheduled", async () => {
    const relay = startMockRelay();
    const accountId = "degraded-snapshot";
    const runtimeCfg = {
      channels: {
        "relay-channel": {
          enabled: true,
          reconnectBackoffMs: 80,
          maxReconnectBackoffMs: 100,
          accounts: [{ id: accountId, url: `ws://127.0.0.1:${relay.port}` }],
        },
      },
    };
    const controller = new AbortController();
    const startTask = relayChannelOpenclawPlugin.gateway!.startAccount({
      cfg: runtimeCfg as never,
      accountId,
      account: { accountId } as never,
      abortSignal: controller.signal,
    } as never);

    await waitForHealthy(runtimeCfg, accountId);
    relay.closeConnection(1012, "relay reboot");
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(
      relayChannelOpenclawPlugin.status!.buildAccountSnapshot({
        cfg: runtimeCfg as never,
        account: { accountId } as never,
      } as never)
    ).toMatchObject({
      accountId,
      running: true,
      connected: false,
      healthState: "degraded",
      recovering: true,
      reconnectScheduled: true,
      lastCloseCode: 1012,
      lastCloseReason: "relay reboot",
    });
    expect(relay.getConnectionCount()).toBe(1);

    controller.abort();
    await startTask;
    await relayChannelOpenclawPlugin.gateway!.stopAccount({
      cfg: runtimeCfg as never,
      accountId,
      account: { accountId } as never,
    } as never);
  });

  it("handles send action through relay message.send", async () => {
    const seenActions: Array<{
      kind: string;
      payload: Record<string, unknown>;
      transportTarget?: { channel?: string; chatId?: string };
    }> = [];
    const relay = startMockRelay({
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
                transportMessageId: "msg-send-action",
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
          accounts: [{ id: "send-action", url: `ws://127.0.0.1:${relay.port}` }],
        },
      },
    };
    const controller = new AbortController();
    const startTask = relayChannelOpenclawPlugin.gateway!.startAccount({
      cfg: runtimeCfg as never,
      accountId: "send-action",
      account: { accountId: "send-action" } as never,
      abortSignal: controller.signal,
    } as never);

    await waitForHealthy(runtimeCfg, "send-action");

    const result = await relayChannelOpenclawPlugin.actions!.handleAction({
      action: "send",
      params: {
        target: "telegram:123",
        message: "Plain relay message",
      },
      cfg: runtimeCfg as never,
      accountId: "send-action",
      toolContext: {},
    } as never);

    expect(result).toMatchObject({
      details: {
        ok: true,
        conversationId: "telegram:123",
        messageId: "msg-send-action",
      },
    });
    expect(seenActions[0]).toMatchObject({
      kind: "message.send",
      payload: {
        text: "Plain relay message",
      },
      transportTarget: {
        channel: "telegram",
        chatId: "123",
      },
    });

    controller.abort();
    await startTask;
    await relayChannelOpenclawPlugin.gateway!.stopAccount({
      cfg: runtimeCfg as never,
      accountId: "send-action",
      account: { accountId: "send-action" } as never,
    } as never);
  });

  it("normalizes plain targets to the inferred provider before relay send", async () => {
    const seenActions: Array<{
      kind: string;
      payload: Record<string, unknown>;
      transportTarget?: { channel?: string; chatId?: string };
    }> = [];
    const relay = startMockRelay({
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
          accounts: [{ id: "implicit-targets", url: `ws://127.0.0.1:${relay.port}` }],
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

});
