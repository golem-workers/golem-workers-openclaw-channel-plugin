import { createMessageToolButtonsSchema } from "openclaw/plugin-sdk/channel-actions";
import type { JsonValue, RelayCapabilitySnapshot, RelayMessageToolDescription } from "../api.js";
import { OPTIONAL_CAPABILITY_TO_ACTION } from "./types.js";

export function describeMessageTool(
  capabilities: RelayCapabilitySnapshot | undefined,
  scope?: string
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

  const buttonsEnabled = hasCapability(capabilities, "telegram.inlineButtons", scope);
  const schema = buttonsEnabled ? [createMessageToolButtonsSchemaFragment()] : undefined;
  return {
    actions: [...new Set(actions)],
    ...(buttonsEnabled ? { capabilities: ["interactive", "buttons"] } : {}),
    ...(schema ? { schema } : {}),
  };
}

function hasCapability(
  capabilities: RelayCapabilitySnapshot,
  capability: string,
  scope?: string
): boolean {
  if (scope && capabilities.targetCapabilities?.[scope]?.[capability] !== undefined) {
    return Boolean(capabilities.targetCapabilities[scope]?.[capability]);
  }
  return Boolean(
    capabilities.optionalCapabilities[capability] ??
      capabilities.providerCapabilities[capability]
  );
}

function createMessageToolButtonsSchemaFragment(): JsonValue {
  return {
    properties: {
      buttons: createMessageToolButtonsSchema() as unknown as JsonValue,
    },
  };
}
