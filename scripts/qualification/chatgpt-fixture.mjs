// Child-Gateway-only synthetic transport. Never load in production.
import fs from "node:fs";
import assert from "node:assert/strict";
const original = globalThis.fetch;
const log = process.env.POOL_98_TRANSPORT_LOG;
assert(log, "Fixture needs a private transport log");
globalThis.fetch = async (input, init) => {
  const url = String(input instanceof globalThis.Request ? input.url : input);
  if (/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/)/.test(url))
    return original(input, init);
  if (
    [
      "https://telemetry.openclaw.ai/api/latest-version",
      "https://chatgpt.com/backend-api/wham/usage",
    ].includes(url)
  ) {
    fs.appendFileSync(
      log,
      JSON.stringify({ blockedBackgroundUrl: url }) + "\n",
    );
    return new globalThis.Response("{}", {
      status: 503,
      headers: { "content-type": "application/json" },
    });
  }
  if (url !== "https://chatgpt.com/backend-api/codex/responses") {
    fs.appendFileSync(log, JSON.stringify({ unexpectedUrl: url }) + "\n");
    throw Error("Synthetic qualification forbids external network");
  }
  const headers = new globalThis.Headers(init?.headers);
  const account = headers.get("chatgpt-account-id");
  fs.appendFileSync(log, JSON.stringify({ account }) + "\n");
  assert(["a", "b"].includes(account), "Only synthetic pool OAuth is allowed");
  if (account === "a")
    return new globalThis.Response(
      JSON.stringify({
        error: {
          message: "synthetic account A rate limited",
          type: "usage_limit_reached",
          code: "rate_limit_exceeded",
        },
      }),
      {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "60" },
      },
    );
  const response = {
    id: "resp_synthetic_98",
    object: "response",
    status: "completed",
    model: "model",
    output: [
      {
        type: "message",
        id: "msg_synthetic_98",
        role: "assistant",
        status: "completed",
        content: [
          {
            type: "output_text",
            text: "POOL_98_SYNTHETIC_B_OK",
            annotations: [],
          },
        ],
      },
    ],
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
  };
  const events = [
    {
      type: "response.created",
      response: { ...response, status: "in_progress", output: [] },
    },
    { type: "response.completed", response },
  ];
  return new globalThis.Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
};
