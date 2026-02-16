// NOTE: This legacy file is kept for now, but it must also obey the rule:
// protocol code cannot be outside `protocol { ... }`.

protocol TaskExecutionLegacy {
  participants: user, comma, sia
  initiator: user
  input: TaskRequest

  user { ctx.taskText = $input.text }
  user --> comma: TaskRequest = { }

  comma --> user: Greeting = {
    onSend: { call: "comma.onAck", args: { text: "Hi! I'll do it now." } }
  }

  comma {
    // internal step: turn user task into DSI/BSI
    const dsiBsi = taskToDsiBsi(ctx.taskText)
  }

  comma --> sia: SubmitIntent = {
    onSend: { call: "comma.onSubmitIntent", args: { ref: "$ctx.dsiBsi" } },
    onReceive: { call: "sia.onIntent", args: { ref: "$msg.intent" } }
  }
}

