message TaskRequest {}
message SubmitIntent {}

// Example 07: child protocol invocation
// Uses protocol-level `invokes` — synchronous call to child protocol (blocks until return).

protocol DeriveDsiBsi {
  participants:
    comma [ts] initiator
  trigger on invoke with DeriveRequest {
    resolve comma = single
  }

  comma {
    $ctx.dsiBsi = taskToDsiBsi($ctx.input.taskText)
    reagent.return($ctx.dsiBsi)
  }
}

protocol TaskExecutionWithChild {
  participants:
    user [ts] initiator,
    comma [ts],
    sia [*]
  trigger on invoke with TaskRequest {
    resolve user = single
    resolve comma = single
    resolve sia = single
  }

  user {
    $ctx.taskText = $ctx.input.text
  }
  user --> comma: TaskRequest = { }

  comma invokes DeriveDsiBsi({ taskText: $ctx.taskText }) -> $ctx.dsiBsi

  comma --> sia: SubmitIntent = {
    onSend {
      $ctx.msg.ref = $ctx.dsiBsi
    }
  }
}

role UserRole [ts] {
  plays TaskExecutionWithChild as user
}

role CommaRole [ts] {
  plays TaskExecutionWithChild as comma
  plays DeriveDsiBsi as comma
}

role SiaRole [*] {
  plays TaskExecutionWithChild as sia
}

agent User runs UserRole
agent Comma runs CommaRole
agent Sia runs SiaRole
