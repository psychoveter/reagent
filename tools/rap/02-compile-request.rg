// RAP sub-protocol: CompileRequest
// Client asks the orchestrator to compile a .rg source file.
// Returns compiled IR, deployment plan, and source map.

message Compile {
  rgSource: string
  fileName: string
}

message CompileSuccess {
  sessionId: string
  irGraphs: any[]
  roleIRs: any[]
  agentIRs: any[]
  deployment: any
  sourceMap: any
}

message CompileError {
  errors: { line: number, column: number, message: string }[]
}

protocol CompileRequest {
  participants:
    client [*] initiator,
    orchestrator [*]
  trigger on invoke with Compile {
    resolve client = single
    resolve orchestrator = single
  }

  client --> orchestrator: Compile

  alt (orchestrator --> client: CompileSuccess) {
  } else (orchestrator --> client: CompileError) {
  }
}

role RAPClient [*] {
  plays CompileRequest as client
}

role RAPCompiler [*] {
  plays CompileRequest as orchestrator
}
