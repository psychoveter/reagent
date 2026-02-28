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
  sessionId: string
  status: string
  agentStates?: any
  returnValue?: any
  finalCtx?: any
  finalSelf?: any
}

message RunFailed {
  sessionId: string
  error: string
}

protocol RunProtocol {
  participants:
    orchestrator [*] initiator,
    adapter [*]
  trigger on invoke with RunStart {
    resolve orchestrator = single
    resolve adapter = single
  }

  orchestrator --> adapter: RunStart

  alt (adapter --> orchestrator: RunCompleted) {
  } else (adapter --> orchestrator: RunFailed) {
  }
}

role RAPRunner [*] {
  plays RunProtocol as orchestrator
}

role RAPExecutor [*] {
  plays RunProtocol as adapter
}
