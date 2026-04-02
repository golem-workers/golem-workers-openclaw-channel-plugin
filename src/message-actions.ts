import type { RelayCapabilitySnapshot, RelayMessageToolDescription, RelayTargetScope } from "../api.js";
import { OPTIONAL_CAPABILITY_TO_ACTION } from "./types.js";

export function describeMessageTool(
  capabilities: RelayCapabilitySnapshot | undefined,
  scope?: RelayTargetScope
): RelayMessageToolDescription {
  const actions = ["send"];
  if (!capabilities) {
    return { actions };
  }

  for (const [capability, action] of Object.entries(OPTIONAL_CAPABILITY_TO_ACTION)) {
    if (hasCapability(capabilities, capability, scope)) {
      actions.push(action);
    }
  }

  return { actions: [...new Set(actions)] };
}

function hasCapability(
  capabilities: RelayCapabilitySnapshot,
  capability: string,
  scope?: RelayTargetScope
): boolean {
  if (scope && capabilities.targetCapabilities?.[scope]?.[capability] !== undefined) {
    return Boolean(capabilities.targetCapabilities[scope]?.[capability]);
  }
  return Boolean(
    capabilities.optionalCapabilities[capability] ??
      capabilities.providerCapabilities[capability]
  );
}
