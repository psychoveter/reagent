// RAP sub-protocol: RunProtocol
// Orchestrator starts a protocol instance. Adapter reports completion.

message RunStart {
  sessionId: string
  instanceId: string
  protocolName: string
  input: any
  mode: string
  roleToAgent: any
}

message RunCompleted {
  instanceId: string
  status: string
  returnValue?: any
  finalCtx?: any
  finalSelf?: any
}

protocol RunProtocol {
  participants: orchestrator [*], adapter [*]
  initiator: orchestrator
  input: RunStart

  orchestrator --> adapter: RunStart
  adapter --> orchestrator: RunCompleted
}

role RAPRunner [*] {
  plays RunProtocol as orchestrator
}

role RAPExecutor [*] {
  plays RunProtocol as adapter
}
