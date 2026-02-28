message TaskRequest {}
message SubmitIntent {}
message Accepted {}
message Done {}
message Failed {}

// Example 06: exception + abort + compensation
// Intent: comma submits intent to sia; if downstream fails, run compensation and notify user.

protocol ExceptionAbortCompensate {
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

  try {
    comma --> sia: SubmitIntent = { }
    sia --> comma: Accepted = { }
    comma --> user: Done = { }
  } catch (error) {
    comma {
      compensate("sia.cancelIntent", { ref: $ctx.intentRef })
    }
    comma --> user: Failed = {
      onSend {
        $ctx.msg.message = $ctx.error
      }
    }
  }
}

role UserRole [ts] {
  plays ExceptionAbortCompensate as user
}

role CommaRole [ts] {
  plays ExceptionAbortCompensate as comma
}

role SiaRole [*] {
  plays ExceptionAbortCompensate as sia
}

agent User runs UserRole
agent Comma runs CommaRole
agent Sia runs SiaRole
