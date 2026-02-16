// Example 06: exception + abort + compensation
// Intent: comma submits intent to sia; if downstream fails, run compensation and notify user.
// Roles: user, comma, sia
//
// Required acts: try/catch (or abort handling), compensation hooks.

protocol ExceptionAbortCompensate {
  participants: user, comma, sia
  initiator: user
  input: TaskRequest

  user {
    ctx.taskText = $input.text
  }
  comma --> user: Greeting = { }

  try {
    comma --> sia: SubmitIntent = { }
    sia --> comma: Accepted = { }
    comma --> user: Done = { }
  } catch (error) {
    comma {
      // compensate / rollback side-effects
      compensate("sia.cancelIntent", { ref: "$ctx.intentRef" })
    }
    comma --> user: Failed = { onSend: { call: "comma.replyError", args: { message: "$error" } } }
  }
}

