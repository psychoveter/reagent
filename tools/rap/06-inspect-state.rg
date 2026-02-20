// RAP sub-protocol: InspectState
// Client queries runtime state of an agent through the orchestrator.

message GetState {
  sessionId: string
  agentName: string
}

message StateSnapshot {
  agentName: string
  stateId: string
  stateKind: string
  ctx: any
  self: any
  pendingMessages: string[]
  recentTraces: any[]
  instanceStatuses: any
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

role RAPInspectClient [*] {
  plays InspectState as client
}

role RAPInspectRelay [*] {
  plays InspectState as orchestrator
}

role RAPInspectTarget [*] {
  plays InspectState as adapter
}
