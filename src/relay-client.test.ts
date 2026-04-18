import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { RelayAccountStatus } from "../api.js";
import { RelayClient } from "./relay-client.js";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        })
    )
  );
});

describe("RelayClient", () => {
  it("re-establishes hello after relay restart", async () => {
    const statuses: RelayAccountStatus[] = [];
    let helloCount = 0;

    const buildRelay = () =>
      createServer(async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        const frame = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as {
          accountId?: string;
        };
        if (req.method === "POST" && req.url === "/hello") {
          helloCount += 1;
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
              providerFeatures: {},
              limits: {},
              dataPlane: {
                uploadBaseUrl: "http://127.0.0.1:43129/uploads",
                downloadBaseUrl: "http://127.0.0.1:43129/downloads",
              },
            })
          );
          return;
        }
        res.statusCode = 404;
        res.end();
      });

    let relay = buildRelay();
    servers.push(relay);
    await listen(relay, 0);
    const address = relay.address();
    if (!address || typeof address === "string") {
      throw new Error("Failed to resolve relay port");
    }
    const relayPort = address.port;

    const client = new RelayClient({
      accountId: "acc-1",
      url: `http://127.0.0.1:${relayPort}`,
      reconnectBackoffMs: 10,
      maxReconnectBackoffMs: 20,
      requestTimeoutMs: 100,
      healthcheckIntervalMs: 25,
    });
    client.on("status", (status) => {
      statuses.push(status);
    });

    await client.start();
    await waitFor(() => helloCount >= 2);
    const helloCountBeforeRestart = helloCount;

    await closeServer(relay);
    relay = buildRelay();
    servers.push(relay);
    await listen(relay, relayPort);

    await waitFor(() => helloCount > helloCountBeforeRestart);
    expect(statuses.some((status) => status.state === "healthy")).toBe(true);

    await client.stop();
  });
});

async function listen(server: Server, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

async function waitFor(check: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for condition");
}
