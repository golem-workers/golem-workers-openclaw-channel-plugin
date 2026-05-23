import { describe, expect, it } from "vitest";
import { inferRelayDeliveryKind, looksLikeToolProgressText } from "./delivery-kind.js";

describe("delivery-kind", () => {
  it("treats message adapter sends as final", () => {
    expect(
      inferRelayDeliveryKind({
        source: "message-adapter",
        text: "🛠️ should still be final on durable path",
      })
    ).toBe("final");
  });

  it("detects outbound tool progress by emoji prefix", () => {
    expect(
      inferRelayDeliveryKind({
        source: "outbound",
        text: "🛠️ ss -ltnp | rg 443",
      })
    ).toBe("tool");
    expect(looksLikeToolProgressText("🔧 elevated · `pwd`")).toBe(true);
  });

  it("detects outbound reasoning blocks", () => {
    expect(
      inferRelayDeliveryKind({
        source: "outbound",
        payload: { text: "thinking...", isReasoning: true },
      })
    ).toBe("block");
  });

  it("defaults outbound user-facing text to final", () => {
    expect(
      inferRelayDeliveryKind({
        source: "outbound",
        text: "Status: 100% complete",
      })
    ).toBe("final");
  });
});
