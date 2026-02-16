// Example 01: Basic task execution (user → comma → sia)
// Intent: user requests a task; comma acknowledges, derives DSI/BSI, submits to sia.
// Roles: user, comma, sia
//
// Expected trace shape (high-level):
// - ProtocolStarted
// - MessageReceived(TaskRequest) by comma
// - MessageSent(Greeting) by comma
// - ActionStarted/ActionFinished(comma.taskToDsiBsi)
// - MessageSent(SubmitIntent) by comma
// - ProtocolCompleted

protocol TaskExecutionBasic {
  participants: user, comma, sia
  initiator: user
  input: TaskRequest

  user {
    ctx.taskText = $input.text
  }
  user --> comma: TaskRequest = { } // explicit forward from initiator to comma

  comma --> user: Greeting = {
    onSend: { call: "comma.onAck", args: { text: "Hi! I'll do it now." } }
  }

  comma {
    // internal action: derive DSI/BSI from task text
    // semantic: this zone compiles into one or more Action steps.
    const dsiBsi = taskToDsiBsi(ctx.taskText)
    ctx.dsiBsi = dsiBsi
  }

  comma --> sia: SubmitIntent = {
    onSend: { call: "comma.onSubmitIntent", args: { ref: "$ctx.dsiBsi" } }
  }
}

