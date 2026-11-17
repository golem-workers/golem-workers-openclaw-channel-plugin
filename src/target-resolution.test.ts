import { describe, expect, it } from "vitest";
import { parseExplicitTarget, qualifyRelayTarget, resolveTarget } from "./target-resolution.js";

describe("host-qualified relay targets", () => {
  it("preserves empty and implicit targets", () => {
    expect(qualifyRelayTarget(" ")).toBe("");
    expect(resolveTarget("relay-channel:123", { defaultChannel: "telegram" }))
      .toEqual(resolveTarget("123", { defaultChannel: "telegram" }));
  });
  it.each(["telegram:123", "telegram:group:-100", "telegram:topic:-100#77", "whatsapp_personal:123@s.whatsapp.net"])(
    "preserves the transport identity for %s", (target) => {
      expect(resolveTarget(qualifyRelayTarget(target))).toEqual(resolveTarget(target));
      expect(parseExplicitTarget(qualifyRelayTarget(target))).toEqual(parseExplicitTarget(target));
      expect(qualifyRelayTarget(qualifyRelayTarget(target))).toBe(qualifyRelayTarget(target));
    }
  );
});
