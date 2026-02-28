message TaskRequest {}
message Greeting {}
message SubmitIntent {}

// Example 01: Basic task execution (user → comma → sia)
// Intent: user requests a task; comma acknowledges, derives DSI/BSI, submits to sia.
//
// $ctx is per-role isolated working memory.

protocol TaskExecutionBasic {
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

  comma --> user: Greeting = {
    onSend {
      console.log("Hi! I'll do it now.")
    }
  }

  comma {
    $ctx.dsiBsi = taskToDsiBsi($ctx.taskText)
  }

  comma --> sia: SubmitIntent = {
    onSend {
      $ctx.msg.ref = $ctx.dsiBsi
    }
  }
}

role UserRole [ts] {
  plays TaskExecutionBasic as user
}

role CommaRole [ts] {
  plays TaskExecutionBasic as comma
}

role SiaRole [*] {
  plays TaskExecutionBasic as sia
}

agent User runs UserRole
agent Comma runs CommaRole
agent Sia runs SiaRole
