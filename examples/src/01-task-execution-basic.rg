message TaskRequest {}
message Greeting {}
message SubmitIntent {}

// Example 01: Basic task execution (user → comma → sia)
// Intent: user requests a task; comma acknowledges, derives DSI/BSI, submits to sia.
// Roles: user [ts], comma [ts], sia [*]
//
// $flow carries data between roles (propagated with messages).
// $ctx is per-role isolated working memory.

protocol TaskExecutionBasic {
  participants: user [ts], comma [ts], sia [*]
  initiator: user
  input: TaskRequest

  user {
    $flow.taskText = $ctx.input.text
  }
  user --> comma: TaskRequest = { }

  comma --> user: Greeting = {
    onSend {
      console.log("Hi! I'll do it now.")
    }
  }

  comma {
    $flow.dsiBsi = taskToDsiBsi($flow.taskText)
  }

  comma --> sia: SubmitIntent = {
    onSend {
      $ctx.msg.ref = $flow.dsiBsi
    }
  }
}
