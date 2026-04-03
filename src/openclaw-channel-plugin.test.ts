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

function startMockRelay() {
  const wss = new WebSocketServer({ port: 0 });
  servers.push(wss);
  wss.on("connection", (ws) => {
    ws.on("message", (raw) => {
      const frame = JSON.parse(raw.toString()) as { type?: string; accountId?: string };
      if (frame.type !== "hello") {
        return;
      }
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
          },
          providerCapabilities: {},
          limits: {},
          dataPlane: {
            uploadBaseUrl: "http://127.0.0.1:43129/uploads",
            downloadBaseUrl: "http://127.0.0.1:43129/downloads",
          },
        })
      );
    });
  });

  const address = wss.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to get mock relay address");
  }
  return address.port;
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
    const runtimeCfg = {
      channels: {
        "relay-channel": {
          enabled: true,
          accounts: [{ id: "default", url: `ws://127.0.0.1:${port}` }],
        },
      },
    };
    const controller = new AbortController();
    let settled = false;

    const task = relayChannelOpenclawPlugin.gateway!.startAccount({
      cfg: runtimeCfg as never,
      accountId: "default",
      account: { accountId: "default" } as never,
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
  });
});
