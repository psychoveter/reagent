message TaskRequest {}
message SubmitIntent {}

// Example 07: child protocol invocation
//
// reagent.invoke() and reagent.return() are functions from the `reagent` runtime library,
// auto-imported into every agent zone.
// reagent.invoke() = synchronous call to child protocol (blocks until return).
// reagent.return() = produce a value from this protocol instance.

protocol DeriveDsiBsi {
  participants: comma [ts]
  initiator: comma
  input: DeriveRequest

  comma {
    const dsiBsi = taskToDsiBsi($ctx.input.taskText)
    $ctx.dsiBsi = dsiBsi
    reagent.return($ctx.dsiBsi)
  }
}

protocol TaskExecutionWithChild {
  participants: user [ts], comma [ts], sia [*]
  initiator: user
  input: TaskRequest

  user {
    $ctx.taskText = $ctx.input.text
  }
  user --> comma: TaskRequest = { }

  comma {
    $ctx.dsiBsi = reagent.invoke(DeriveDsiBsi, { taskText: $ctx.taskText })
  }

  comma --> sia: SubmitIntent = {
    onSend {
      $ctx.msg.ref = $ctx.dsiBsi
    }
  }
}
