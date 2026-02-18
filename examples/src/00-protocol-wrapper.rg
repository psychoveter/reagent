message TaskRequest {}
message Greeting {}
message SubmitIntent {}

// Example 00: protocol wrapper + participants + initiator + input(start)
//
// This is the canonical top-level structure we want.
// The protocol block contains:
// - participants: roles involved (each with a language tag)
// - initiator: which role starts the protocol
// - input: which inbound message triggers ProtocolStarted (delivered to initiator)
//
// Language tag is declared once per participant: comma [ts].
// Agent zones use bare role name: comma { ... }
// $ctx is injected by the runtime as the protocol instance context.
// onSend / onReceive in message props open inline agent zones for the sender / receiver.

protocol TaskExecution {
  participants: user [ts], comma [ts], sia [*]
  initiator: user
  input: TaskRequest

  // Input message is delivered to initiator (user). Sender is unknown/out-of-scope.
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
    const dsiBsi = taskToDsiBsi($ctx.taskText)
    $ctx.dsiBsi = dsiBsi
  }

  comma --> sia: SubmitIntent = {
    onSend {
      $ctx.msg.ref = $ctx.dsiBsi
    }
  }
}
