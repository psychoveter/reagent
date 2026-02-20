message TaskRequest {}
message SubmitIntent {}
message Accepted {}
message Done {}
message Failed {}

// Example 06: exception + abort + compensation
// Intent: comma submits intent to sia; if downstream fails, run compensation and notify user.

protocol ExceptionAbortCompensate {
  participants: user [ts], comma [ts], sia [*]
  initiator: user
  input: TaskRequest

  user {
    $flow.taskText = $ctx.input.text
  }
  user --> comma: TaskRequest = { }

  try {
    comma --> sia: SubmitIntent = { }
    sia --> comma: Accepted = { }
    comma --> user: Done = { }
  } catch (error) {
    comma {
      compensate("sia.cancelIntent", { ref: $flow.intentRef })
    }
    comma --> user: Failed = {
      onSend {
        $ctx.msg.message = $ctx.error
      }
    }
  }
}
