// RAP sub-protocol: SetBreakpoints
// Client configures breakpoints; orchestrator resolves source locations to IR state IDs.
// Supports message-name breakpoints, source-location breakpoints, and state-kind breakpoints.

message SetBreakpointsRequest {
  sessionId: string
  messageBreakpoints: string[]
  sourceLocations: { file: string, line: number }[]
  stateKindBreakpoints: string[]
}

message BreakpointsResolved {
  sessionId: string
  resolved: { type: string, stateId?: string, messageName?: string, file?: string, line?: number }[]
}

protocol SetBreakpoints {
  participants: client [*], orchestrator [*]
  initiator: client
  input: SetBreakpointsRequest

  client --> orchestrator: SetBreakpointsRequest
  orchestrator --> client: BreakpointsResolved
}

role RAPBreakpointClient [*] {
  plays SetBreakpoints as client
}

role RAPBreakpointResolver [*] {
  plays SetBreakpoints as orchestrator
}
