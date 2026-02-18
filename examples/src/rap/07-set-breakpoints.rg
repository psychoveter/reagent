// RAP sub-protocol: SetBreakpoints
// Client configures breakpoints; orchestrator resolves source locations to IR state IDs.

message SetBreakpointsRequest {
  sourceLocations: { file: string, line: number }[]
}

message BreakpointsResolved {
  breakpoints: { stateId: string, file: string, line: number }[]
}

protocol SetBreakpoints {
  participants: client [*], orchestrator [*]
  initiator: client
  input: SetBreakpointsRequest

  client --> orchestrator: SetBreakpointsRequest
  orchestrator --> client: BreakpointsResolved
}
