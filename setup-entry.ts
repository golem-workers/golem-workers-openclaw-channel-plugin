import { defineSetupPluginEntry } from "./openclaw-sdk.js";
import { relayChannelOpenclawPlugin } from "./src/openclaw-channel-plugin.js";

export default defineSetupPluginEntry(relayChannelOpenclawPlugin);

export { relayChannelOpenclawPlugin as relayChannelSetupEntry };
