message TaskRequest {}
message SubmitIntent {}

// Example 07: child protocol invocation
// Uses protocol-level `invokes` instead of zone-level reagent.invoke().
// invokes = synchronous call to child protocol (blocks until return).

protocol DeriveDsiBsi {
  participants: comma [ts]
  initiator: comma
  input: DeriveRequest

  comma {
    $ctx.dsiBsi = taskToDsiBsi($ctx.input.taskText)
    reagent.return($ctx.dsiBsi)
  }
}

protocol TaskExecutionWithChild {
  participants: user [ts], comma [ts], sia [*]
  initiator: user
  input: TaskRequest

  user {
    $flow.taskText = $ctx.input.text
  }
  user --> comma: TaskRequest = { }

  comma invokes DeriveDsiBsi({ taskText: $flow.taskText }) -> $flow.dsiBsi

  comma --> sia: SubmitIntent = {
    onSend {
      $ctx.msg.ref = $flow.dsiBsi
    }
  }
}
