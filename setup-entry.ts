import { defineSetupPluginEntry } from "openclaw/plugin-sdk/core";
import { relayChannelOpenclawPlugin } from "./src/openclaw-channel-plugin.js";

export default defineSetupPluginEntry(relayChannelOpenclawPlugin);

export { relayChannelOpenclawPlugin as relayChannelSetupEntry };
