/**
 * AgentBehavior — the pluggable executable object attached to an AgentShell.
 *
 * Realizations:
 *   - ManagedAgentBehavior: executes .rg zone code via zone-executor
 *   - Custom user behavior: user-supplied handle() implementation
 *   - McpAgentAdapter: bridges ProtocolEvents to an MCP client
 *   - GateBehavior: proxies events through a gate transport
 */

import type { ProtocolEvent, AgentResponse } from "../core/protocol-engine.js";

export interface AgentBehavior {
  handle(event: ProtocolEvent): Promise<AgentResponse>;
}
