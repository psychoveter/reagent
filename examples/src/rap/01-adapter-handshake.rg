// RAP sub-protocol: AdapterHandshake
// Runtime adapter registers with the orchestrator.

message Register {
  adapterId: string
  capabilities: string[]
  maxAgents: number
}

message Accepted {}

message Rejected {
  reason: string
}

protocol AdapterHandshake {
  participants: adapter [*], orchestrator [*]
  initiator: adapter
  input: Register

  adapter --> orchestrator: Register

  alt (orchestrator --> adapter: Accepted) {
  } else (orchestrator --> adapter: Rejected) {
  }
}
