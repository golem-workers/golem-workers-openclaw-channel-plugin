import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { controlPlaneEventSchema } from "./protocol/control-plane.js";

type RelayEventHandler = (event: Record<string, unknown>) => void;

type EventIngressRuntime = {
  server: ReturnType<typeof createServer>;
  handlers: Map<string, RelayEventHandler>;
};

const ingressServers = new Map<number, EventIngressRuntime>();

export async function registerRelayEventIngress(input: {
  accountId: string;
  relayUrl: string;
  onEvent: RelayEventHandler;
}): Promise<{ port: number; close: () => Promise<void> }> {
  const relayUrl = new URL(input.relayUrl);
  const relayPort = Number(relayUrl.port);
  if (!Number.isFinite(relayPort) || relayPort <= 0) {
    throw new Error(`Invalid relay URL port: ${input.relayUrl}`);
  }
  const ingressPort = relayPort + 2;
  const runtime = ingressServers.get(ingressPort) ?? createIngressRuntime(ingressPort);
  runtime.handlers.set(input.accountId, input.onEvent);
  return {
    port: ingressPort,
    close: async () => {
      runtime.handlers.delete(input.accountId);
      if (runtime.handlers.size > 0) {
        return;
      }
      ingressServers.delete(ingressPort);
      await new Promise<void>((resolve) => {
        runtime.server.close(() => resolve());
      });
    },
  };
}

export async function closeAllRelayEventIngressServersForTest(): Promise<void> {
  const runtimes = [...ingressServers.values()];
  ingressServers.clear();
  await Promise.all(
    runtimes.map(
      (runtime) =>
        new Promise<void>((resolve) => {
          runtime.handlers.clear();
          runtime.server.close(() => resolve());
        })
    )
  );
}

function createIngressRuntime(port: number): EventIngressRuntime {
  const handlers = new Map<string, RelayEventHandler>();
  const server = createServer((req, res) => {
    void handleIngressRequest(req, res, handlers);
  });
  server.listen(port, "127.0.0.1");
  const runtime = { server, handlers };
  ingressServers.set(port, runtime);
  return runtime;
}

async function handleIngressRequest(
  req: IncomingMessage,
  res: ServerResponse,
  handlers: Map<string, RelayEventHandler>
) {
  try {
    if (req.method !== "POST") {
      sendJson(res, 405, { ok: false, error: "METHOD_NOT_ALLOWED" });
      return;
    }
    const raw = await readJsonBody(req);
    const event = controlPlaneEventSchema.parse(raw);
    const accountId =
      readOptionalString((event as { payload?: { accountId?: string } }).payload?.accountId) ??
      resolveSingleRegisteredAccountId(handlers);
    if (!accountId) {
      sendJson(res, 404, { ok: false, error: "ACCOUNT_NOT_REGISTERED" });
      return;
    }
    const handler = handlers.get(accountId);
    if (!handler) {
      sendJson(res, 404, { ok: false, error: "ACCOUNT_NOT_REGISTERED" });
      return;
    }
    handler(event as Record<string, unknown>);
    sendJson(res, 202, { ok: true });
  } catch (error) {
    sendJson(res, 400, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text.length > 0 ? (JSON.parse(text) as unknown) : {};
}

function sendJson(res: ServerResponse, statusCode: number, payload: Record<string, unknown>) {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(payload));
}

function readOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function resolveSingleRegisteredAccountId(handlers: Map<string, RelayEventHandler>): string | null {
  if (handlers.size !== 1) {
    return null;
  }
  return handlers.keys().next().value ?? null;
}
