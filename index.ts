import { defineChannelPluginEntry } from "./api.js";
import { createRelayChannelPlugin } from "./src/channel.js";

export * from "./api.js";
export * from "./runtime-api.js";

export default defineChannelPluginEntry({
  id: "relay-channel",
  create() {
    return createRelayChannelPlugin();
  },
});
