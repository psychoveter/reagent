message TaskRequest {}
message Greeting {}
message SubmitIntent {}

// Example 00: protocol wrapper + participants + initiator + input(start)
//
// Demonstrates the canonical top-level structure.
// $ctx is per-role isolated state. $flow is propagated with every message.
// onSend / onReceive in message props open inline agent zones.

protocol TaskExecution {
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
    const dsiBsi = taskToDsiBsi($flow.taskText)
    $flow.dsiBsi = dsiBsi
  }

  comma --> sia: SubmitIntent = {
    onSend {
      $ctx.msg.ref = $flow.dsiBsi
    }
  }
}
