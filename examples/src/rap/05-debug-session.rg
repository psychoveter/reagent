// RAP sub-protocol: DebugSession
// Client sends a debug command through orchestrator to an adapter.
// Adapter reports back when execution stops.

message DebugCommand {
  command: string
  targetAgent: string
}

message Stopped {
  stateId: string
  reason: string
  ctx?: any
  self?: any
}

protocol DebugSession {
  participants: client [*], orchestrator [*], adapter [*]
  initiator: client
  input: DebugCommand

  client --> orchestrator: DebugCommand
  orchestrator --> adapter: DebugCommand

  adapter --> orchestrator: Stopped
  orchestrator --> client: Stopped
}
