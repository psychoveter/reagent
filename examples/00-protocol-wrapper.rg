// Example 00: protocol wrapper + participants + initiator + input(start)
//
// This is the canonical top-level structure we want.
// The protocol block contains:
// - participants: roles involved
// - initiator: which role starts the protocol
// - input: which inbound message triggers ProtocolStarted (delivered to initiator)

protocol TaskExecution {
  participants: user, comma, sia
  initiator: user
  input: TaskRequest

  // Input message is delivered to initiator (user). Sender is unknown/out-of-scope.
  user {
    // forward user intent to comma
    // $input is the protocol input message
    ctx.taskText = $input.text
  }
  user --> comma: TaskRequest = { }

  comma --> user: Greeting = {
    onSend: { call: "comma.onAck", args: { text: "Hi! I'll do it now." } }
  }

  comma {
    const dsiBsi = taskToDsiBsi(ctx.taskText)
    ctx.dsiBsi = dsiBsi
  }

  comma --> sia: SubmitIntent = {
    onSend: { call: "comma.onSubmitIntent", args: { ref: "$ctx.dsiBsi" } }
  }
}

