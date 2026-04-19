import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { closeAllRelayEventIngressServersForTest } from "./event-ingress.js";
import { relayChannelOpenclawPlugin } from "./openclaw-channel-plugin.js";

type RelayTestConfig = Record<string, unknown>;

const cfg: RelayTestConfig = {
  channels: {
    "relay-channel": {
      enabled: true,
      accounts: [{ id: "default", port: 43129 }],
    },
  },
};

const servers: Server[] = [];

afterEach(async () => {
  await closeAllRelayEventIngressServersForTest();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => {
            resolve();
          });
        })
    )
  );
});

async function startMockRelay(options?: {
  optionalCapabilities?: Record<string, boolean>;
  providerCapabilities?: Record<string, boolean>;
  transportProvider?: string;
  providerProfiles?: Record<string, unknown>;
  targetCapabilities?: Record<string, Record<string, boolean>>;
  onAction?: (frame: {
    type: "request";
    requestType: "transport.action";
    requestId: string;
    action: {
      actionId: string;
      kind: string;
      payload: Record<string, unknown>;
      transportTarget?: { channel?: string; chatId?: string };
    };
  }) => Record<string, unknown>;
}) {
  let connectionCount = 0;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const frame = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as {
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
    if (req.method === "POST" && req.url === "/hello") {
      connectionCount += 1;
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          type: "hello",
          protocolVersion: 1,
          role: "local-relay",
          relayInstanceId: "relay-1",
          accountId: frame.accountId ?? "default",
          transport: {
            provider: options?.transportProvider ?? "telegram",
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
          ...(options?.providerProfiles ? { providerProfiles: options.providerProfiles } : {}),
          ...(options?.targetCapabilities ? { targetCapabilities: options.targetCapabilities } : {}),
          limits: {},
          dataPlane: {
            uploadBaseUrl: "http://127.0.0.1:43129/uploads",
            downloadBaseUrl: "http://127.0.0.1:43129/downloads",
          },
        })
      );
      return;
    }
    if (req.method === "POST" && req.url === "/actions" && frame.requestId && frame.action) {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify(
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
            }
          ) ?? {
            type: "event",
            eventType: "transport.action.completed",
            payload: {
              requestId: frame.requestId,
              actionId: frame.action.actionId,
              result: {
                transportMessageId: "default-action",
                conversationId: "telegram:123",
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
    getConnectionCount: () => connectionCount,
  };
}

async function waitForHealthy(cfg: RelayTestConfig, accountId = "default") {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const snapshot = relayChannelOpenclawPlugin.status!.buildAccountSnapshot!({
      cfg: cfg as never,
      account: { accountId } as never,
    } as never) as { healthState?: string };
    if (snapshot.healthState === "healthy") {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${accountId} relay runtime to become healthy`);
}

describe("relayChannelOpenclawPlugin", () => {
  it("resolves explicit relay targets through messaging fallback", async () => {
    const resolved = await relayChannelOpenclawPlugin.messaging!.targetResolver!.resolveTarget!({
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

    const results = await relayChannelOpenclawPlugin.resolver!.resolveTargets!({
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
    const relay = await startMockRelay();
    const accountId = "gateway-task";
    const runtimeCfg = {
      channels: {
        "relay-channel": {
          enabled: true,
          accounts: [{ id: accountId, url: `http://127.0.0.1:${relay.port}` }],
        },
      },
    };
    const controller = new AbortController();
    let settled = false;

    const task = relayChannelOpenclawPlugin.gateway!.startAccount!({
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
      relayChannelOpenclawPlugin.status!.buildAccountSnapshot!({
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

    await relayChannelOpenclawPlugin.gateway!.stopAccount!({
      cfg: runtimeCfg as never,
      accountId,
      account: { accountId } as never,
    } as never);
  });

  it("shows degraded relay runtime when local HTTP action fails", async () => {
    const relay = await startMockRelay();
    const accountId = "degraded-snapshot";
    const runtimeCfg = {
      channels: {
        "relay-channel": {
          enabled: true,
          accounts: [{ id: accountId, url: `http://127.0.0.1:${relay.port}` }],
        },
      },
    };
    const controller = new AbortController();
    const startTask = relayChannelOpenclawPlugin.gateway!.startAccount!({
      cfg: runtimeCfg as never,
      accountId,
      account: { accountId } as never,
      abortSignal: controller.signal,
    } as never);

    await waitForHealthy(runtimeCfg, accountId);
    await relayChannelOpenclawPlugin.gateway!.stopAccount!({
      cfg: runtimeCfg as never,
      accountId,
      account: { accountId } as never,
    } as never);

    expect(
      relayChannelOpenclawPlugin.status!.buildAccountSnapshot!({
        cfg: runtimeCfg as never,
        account: { accountId } as never,
      } as never)
    ).toMatchObject({
      accountId,
      running: false,
      connected: false,
      healthState: "stopped",
    });

    controller.abort();
    await startTask;
  });

  it("handles send action through relay message.send", async () => {
    const seenActions: Array<{
      kind: string;
      payload: Record<string, unknown>;
      transportTarget?: { channel?: string; chatId?: string };
    }> = [];
    const relay = await startMockRelay({
      onAction(frame) {
        seenActions.push({
          kind: frame.action.kind,
          payload: frame.action.payload,
          transportTarget: frame.action.transportTarget,
        });
        return {
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
        };
      },
    });
    const runtimeCfg = {
      channels: {
        "relay-channel": {
          enabled: true,
          accounts: [{ id: "send-action", url: `http://127.0.0.1:${relay.port}` }],
        },
      },
    };
    const controller = new AbortController();
    const startTask = relayChannelOpenclawPlugin.gateway!.startAccount!({
      cfg: runtimeCfg as never,
      accountId: "send-action",
      account: { accountId: "send-action" } as never,
      abortSignal: controller.signal,
    } as never);

    await waitForHealthy(runtimeCfg, "send-action");

    const result = await relayChannelOpenclawPlugin.actions!.handleAction!({
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
    await relayChannelOpenclawPlugin.gateway!.stopAccount!({
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
    const relay = await startMockRelay({
      onAction(frame) {
        seenActions.push({
          kind: frame.action.kind,
          payload: frame.action.payload,
          transportTarget: frame.action.transportTarget,
        });
        return {
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
        };
      },
    });
    const runtimeCfg = {
      channels: {
        "relay-channel": {
          enabled: true,
          accounts: [{ id: "implicit-targets", url: `http://127.0.0.1:${relay.port}` }],
        },
      },
    };
    const controller = new AbortController();
    const startTask = relayChannelOpenclawPlugin.gateway!.startAccount!({
      cfg: runtimeCfg as never,
      accountId: "implicit-targets",
      account: { accountId: "implicit-targets" } as never,
      abortSignal: controller.signal,
    } as never);

    await waitForHealthy(runtimeCfg, "implicit-targets");

    await relayChannelOpenclawPlugin.outbound!.sendText!({
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
    await relayChannelOpenclawPlugin.gateway!.stopAccount!({
      cfg: runtimeCfg as never,
      accountId: "implicit-targets",
      account: { accountId: "implicit-targets" } as never,
    } as never);
  });

  it("normalizes plain group targets to telegram when multi-provider relay exposes group support only there", async () => {
    const seenActions: Array<{
      kind: string;
      payload: Record<string, unknown>;
      transportTarget?: { channel?: string; chatId?: string };
    }> = [];
    const relay = await startMockRelay({
      transportProvider: "multi",
      providerProfiles: {
        telegram: {
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
            typing: true,
            fileDownloads: true,
          },
          providerCapabilities: {},
          targetCapabilities: {
            dm: { typing: true, fileDownloads: true },
            group: { typing: true, fileDownloads: true },
          },
          limits: {},
        },
        whatsapp_personal: {
          transport: {
            provider: "whatsapp_personal",
            providerVersion: "relay-backend-bridge",
          },
          coreCapabilities: {
            messageSend: true,
            mediaSend: true,
            replyTo: true,
          },
          optionalCapabilities: {},
          providerCapabilities: {},
          limits: {},
        },
      },
      targetCapabilities: {
        dm: { typing: true, fileDownloads: true },
        group: { typing: true, fileDownloads: true },
      },
      onAction(frame) {
        seenActions.push({
          kind: frame.action.kind,
          payload: frame.action.payload,
          transportTarget: frame.action.transportTarget,
        });
        return {
          type: "event",
          eventType: "transport.action.completed",
          payload: {
            requestId: frame.requestId,
            actionId: frame.action.actionId,
            result: {
              transportMessageId: "msg-group-implicit",
              conversationId: "telegram:group:-5218477136",
            },
          },
        };
      },
    });
    const runtimeCfg = {
      channels: {
        "relay-channel": {
          enabled: true,
          accounts: [{ id: "implicit-group-targets", url: `http://127.0.0.1:${relay.port}` }],
        },
      },
    };
    const controller = new AbortController();
    const startTask = relayChannelOpenclawPlugin.gateway!.startAccount!({
      cfg: runtimeCfg as never,
      accountId: "implicit-group-targets",
      account: { accountId: "implicit-group-targets" } as never,
      abortSignal: controller.signal,
    } as never);

    await waitForHealthy(runtimeCfg, "implicit-group-targets");

    await relayChannelOpenclawPlugin.outbound!.sendText!({
      cfg: runtimeCfg as never,
      to: "-5218477136",
      text: "group hello",
      accountId: "implicit-group-targets",
    } as never);

    expect(seenActions[0]).toMatchObject({
      kind: "message.send",
      payload: {
        text: "group hello",
      },
      transportTarget: {
        channel: "telegram",
        chatId: "-5218477136",
      },
    });

    controller.abort();
    await startTask;
    await relayChannelOpenclawPlugin.gateway!.stopAccount!({
      cfg: runtimeCfg as never,
      accountId: "implicit-group-targets",
      account: { accountId: "implicit-group-targets" } as never,
    } as never);
  });

});
