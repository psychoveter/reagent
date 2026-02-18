// RAP sub-protocol: RunProtocol
// Orchestrator starts a protocol instance on a runtime adapter.

message RunStart {
  instanceId: string
  protocolName: string
  input: any
  mode: string
}

message RunCompleted {
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
