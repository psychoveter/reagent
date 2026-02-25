// NOTE: Legacy example, kept for reference. Superseded by 01-task-execution-basic.rg.

message TaskRequest {}
message Greeting {}
message SubmitIntent {}

protocol TaskExecutionLegacy {
  participants: user [ts], comma [ts], sia [ts]
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
    $ctx.dsiBsi = taskToDsiBsi($ctx.taskText)
  }

  comma --> sia: SubmitIntent = {
    onSend {
      $ctx.msg.ref = $ctx.dsiBsi
    }
    onReceive {
      $ctx.intent = $ctx.msg.ref
    }
  }
}
