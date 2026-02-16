// Example 07: child protocol invocation
//
// We need a way to define a child protocol and call it from a parent protocol.
// The syntax below is provisional; the goal is to clarify required semantics:
// - child protocol gets its own instanceId
// - parent links to child via causality (InvocationStarted/InvocationFinished)
// - arguments are passed and results returned (at least as ctx bindings)

protocol DeriveDsiBsi {
  participants: comma
  initiator: comma
  input: DeriveRequest

  comma {
    const dsiBsi = taskToDsiBsi(ctx.taskText)
    ctx.dsiBsi = dsiBsi
  }
}

protocol TaskExecutionWithChild {
  participants: user, comma, sia
  initiator: user
  input: TaskRequest

  user {
    ctx.taskText = $input.text
  }

  // Invoke child protocol as a step.
  // Proposed: invoke <ProtocolName> = { input: {...}, out: "...", onDone: {...} }
  invoke DeriveDsiBsi = {
    input: { taskText: "$ctx.taskText" },
    out: "dsiBsi"
  }

  comma --> sia: SubmitIntent = {
    onSend: { call: "comma.onSubmitIntent", args: { ref: "$ctx.dsiBsi" } }
  }
}

