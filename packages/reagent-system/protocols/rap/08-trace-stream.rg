// RAP sub-protocol: TraceStream
// Adapter pushes real-time trace events and session status changes to connected clients
// through the orchestrator. This is a streaming (push) protocol — no request/response.

message TraceEvent {
  instanceId: string
  kind: string
  agentName: string
  role?: string
  protocolName?: string
  data?: any
  timestamp?: number
}

message SessionStatus {
  sessionId: string
  status: string
  reason?: string
}

protocol TraceStream {
  participants: adapter [*], orchestrator [*], client [*]
  initiator: adapter

  adapter --> orchestrator: TraceEvent
  orchestrator --> client: TraceEvent

  adapter --> orchestrator: SessionStatus
  orchestrator --> client: SessionStatus
}

role RAPTraceSource [*] {
  plays TraceStream as adapter
}

role RAPTraceRelay [*] {
  plays TraceStream as orchestrator
}

role RAPTraceConsumer [*] {
  plays TraceStream as client
}
