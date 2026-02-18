// RAP sub-protocol: InspectState
// Client queries runtime state of an agent through the orchestrator.

message GetState {
  agentName: string
}

message StateSnapshot {
  stateId: string
  ctx: any
  self: any
  pendingMessages: string[]
  recentTraces: any[]
}

protocol InspectState {
  participants: client [*], orchestrator [*], adapter [*]
  initiator: client
  input: GetState

  client --> orchestrator: GetState
  orchestrator --> adapter: GetState

  adapter --> orchestrator: StateSnapshot
  orchestrator --> client: StateSnapshot
}
