// RAP sub-protocol: ListAgents
// Client queries the agent registry with optional filter expression.
// Supports the resolve filter expression DSL for agent selection.

message ListAgentsRequest {
  requestId: string
  filter?: string       // Filter expression DSL (e.g. "agent.tags contains 'gpu'")
  role?: string         // Filter by role name
  protocolName?: string // Filter by protocol
  status?: string       // Filter by status: running | stopped | error | deploying
  limit?: number        // Max results (default: 100)
  offset?: number       // Pagination offset
}

message ListAgentsResponse {
  requestId: string
  agents: any           // RegistryAgentEntry[] — full metadata including tags, capabilities, labels
  total: number         // Total matching count (before limit/offset)
}

protocol ListAgents {
  participants:
    client [*] initiator,
    ros [*]
  trigger on invoke with ListAgentsRequest {
    resolve client = single
    resolve ros = single
  }

  client --> ros: ListAgentsRequest
  ros --> client: ListAgentsResponse
}

role RAPListAgentsRequester [*] {
  plays ListAgents as client
}

role RAPListAgentsProvider [*] {
  plays ListAgents as ros
}
