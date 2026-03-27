/**
 * SideClaw — OpenClaw channel plugin for real-time AI voice conversations.
 *
 * Connects an OpenClaw agent to the SideClaw voice platform, enabling the agent
 * to participate in live voice calls with embodied characters. The gateway
 * initiates the connection to SideClaw and maintains a persistent session
 * for RPC communication.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { sideClawChannel } from "./channel.js";

export default function register(api: OpenClawPluginApi) {
  api.registerChannel({ plugin: sideClawChannel });
  api.logger.info("sideclaw: channel registered");
}
