message TaskRequest {}
message Greeting {}
message SubmitIntent {}

// Example 01: Basic task execution (user → comma → sia)
// Intent: user requests a task; comma acknowledges, derives DSI/BSI, submits to sia.
// Roles: user [ts], comma [ts], sia [ts]
//
// Expected trace shape (high-level):
// - ProtocolStarted
// - MessageReceived(TaskRequest) by comma
// - MessageSent(Greeting) by comma
// - ActionStarted/ActionFinished(comma.taskToDsiBsi)
// - MessageSent(SubmitIntent) by comma
// - ProtocolCompleted

protocol TaskExecutionBasic {
  participants: user [ts], comma [ts], sia [*]
  initiator: user
  input: TaskRequest

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
    // internal action: derive DSI/BSI from task text
    const dsiBsi = taskToDsiBsi($ctx.taskText)
    $ctx.dsiBsi = dsiBsi
  }

  comma --> sia: SubmitIntent = {
    onSend {
      $ctx.msg.ref = $ctx.dsiBsi
    }
  }
}
