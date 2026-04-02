import { defineChannelPluginEntry } from "openclaw/plugin-sdk/core";
import { relayChannelOpenclawPlugin } from "./src/openclaw-channel-plugin.js";

export * from "./api.js";
export * from "./runtime-api.js";

export default defineChannelPluginEntry({
  id: "relay-channel",
  name: "Relay Channel",
  description: "Relay-backed OpenClaw channel plugin.",
  plugin: relayChannelOpenclawPlugin,
});
