import { describe, expect, it } from "vitest";
import { parseRelayChannelPluginConfig } from "./config.js";
import {
  resolveSelfNudgeSettings,
  runSelfNudgeCheck,
  type OpenClawSessionMessage,
} from "./self-nudge.js";

describe("self-nudge runtime", () => {
  it("parses disabled defaults from relay config", () => {
    const settings = resolveSelfNudgeSettings({ accounts: [] });

    expect(settings).toEqual({
      enabled: false,
      analyzedRecentMessageCount: 0,
      baseTimeoutMs: 300000,
    });
  });

  it("parses self-nudge settings from channel config", () => {
    const config = parseRelayChannelPluginConfig({
      selfNudge: {
        enabled: true,
        analyzedRecentMessageCount: 3,
        baseTimeoutMs: 45000,
        model: "openai/gpt-5-mini",
      },
    });

    expect(resolveSelfNudgeSettings(config)).toEqual({
      enabled: true,
      analyzedRecentMessageCount: 3,
      baseTimeoutMs: 45000,
      model: "openai/gpt-5-mini",
    });
  });

  it("checks the freshest session, sends dynamic nudge body, and backs off", async () => {
    const sent: Array<{ sessionId: string; message: string }> = [];
    const messages: OpenClawSessionMessage[] = [
      { id: "m1", role: "user", content: "please finish this" },
      { id: "m2", role: "assistant", content: "working" },
    ];
    const runtime = {
      sessions: {
        list: async () => [
          { id: "old", updatedAt: "2026-01-01T00:00:00Z" },
          { id: "fresh", updatedAt: "2026-01-02T00:00:00Z" },
        ],
        getMessages: async (input: { sessionId: string; limit: number }) => {
          expect(input).toEqual({ sessionId: "fresh", id: "fresh", limit: 2 });
          return messages;
        },
      },
      llm: {
        generateText: async () =>
          JSON.stringify({ nudgeNeeded: true, body: "Continue from the last pending step." }),
      },
      messages: {
        sendSelf: async (input: { sessionId: string; message: string }) => {
          sent.push(input);
        },
      },
    };

    const state = await runSelfNudgeCheck({
      runtime,
      settings: {
        enabled: true,
        analyzedRecentMessageCount: 1,
        baseTimeoutMs: 10000,
        model: "openai/gpt-test",
      },
      state: {
        consecutiveNudgesWithoutUserReply: 0,
        lastObservedUserMessageId: null,
        lastNudgeAtMs: null,
        lastDecision: null,
        nextDelayMs: null,
      },
      nowMs: 123,
    });

    expect(sent).toEqual([
      expect.objectContaining({
        sessionId: "fresh",
        message: "Continue from the last pending step.",
      }),
    ]);
    expect(state.consecutiveNudgesWithoutUserReply).toBe(1);
    expect(state.lastObservedUserMessageId).toBe("m1");
    expect(state.lastNudgeAtMs).toBe(123);
    expect(state.nextDelayMs).toBe(20000);
  });

  it("resets consecutive nudge backoff when a new user message appears", async () => {
    const sent: Array<{ sessionId: string; message: string }> = [];
    const runtime = {
      sessions: {
        list: async () => [{ id: "fresh", updatedAt: 2 }],
        getMessages: async () => [
          { id: "u2", role: "user", content: "new input" },
          { id: "a2", role: "assistant", content: "still working" },
        ],
      },
      llm: {
        generateText: async () => JSON.stringify({ nudgeNeeded: false }),
      },
      messages: {
        sendSelf: async (input: { sessionId: string; message: string }) => {
          sent.push(input);
        },
      },
    };

    const state = await runSelfNudgeCheck({
      runtime,
      settings: {
        enabled: true,
        analyzedRecentMessageCount: 1,
        baseTimeoutMs: 10000,
      },
      state: {
        consecutiveNudgesWithoutUserReply: 3,
        lastObservedUserMessageId: "u1",
        lastNudgeAtMs: 100,
        lastDecision: null,
        nextDelayMs: 40000,
      },
    });

    expect(sent).toEqual([]);
    expect(state.consecutiveNudgesWithoutUserReply).toBe(0);
    expect(state.lastObservedUserMessageId).toBe("u2");
    expect(state.nextDelayMs).toBe(10000);
  });
});
