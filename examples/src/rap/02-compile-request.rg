// RAP sub-protocol: CompileRequest
// Client asks the orchestrator to compile a .rg source file.

message Compile {
  rgSource: string
  fileName: string
}

message CompileSuccess {
  irGraphs: any[]
  agentIRs: any[]
  deployment: any
  sourceMap: any
}

message CompileError {
  errors: { line: number, message: string }[]
}

protocol CompileRequest {
  participants: client [*], orchestrator [*]
  initiator: client
  input: Compile

  client --> orchestrator: Compile

  alt (orchestrator --> client: CompileSuccess) {
  } else (orchestrator --> client: CompileError) {
  }
}
