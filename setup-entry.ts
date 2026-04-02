import { parseRelayChannelPluginConfig } from "./src/config.js";
import { inspectRelaySetup } from "./src/setup.js";

export const relayChannelSetupEntry = {
  parse: parseRelayChannelPluginConfig,
  inspect: inspectRelaySetup,
};

export default relayChannelSetupEntry;
