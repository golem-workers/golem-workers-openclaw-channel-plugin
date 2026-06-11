import { defineChannelPluginEntry } from "./openclaw-sdk.js";
import {
  relayChannelOpenclawPlugin,
  setRelayChannelOpenClawRuntime,
} from "./src/openclaw-channel-plugin.js";

export * from "./api.js";
export * from "./runtime-api.js";

export default defineChannelPluginEntry({
  id: "relay-channel",
  name: "Relay Channel",
  description: "Relay-backed OpenClaw channel plugin.",
  plugin: relayChannelOpenclawPlugin,
  setRuntime: setRelayChannelOpenClawRuntime,
});
