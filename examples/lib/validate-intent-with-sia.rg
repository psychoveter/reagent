// Library protocol: multi-party child protocol (comma ↔ sia)
//
// Intent: comma asks sia to validate an intent; sia replies OK or Error.
// This protocol is meant to be *invoked* from a parent protocol.

protocol ValidateIntentWithSia {
  participants: comma, sia
  initiator: comma
  input: ValidateIntent

  comma --> sia: ValidateIntent = {
    onSend: { call: "comma.sendForValidation", args: { ref: "$ctx.intent" } }
  }

  alt (sia --> comma: ValidationOk = { }) {
    comma { ctx.validation = { ok: true } }
  } else (sia --> comma: ValidationError = { }) {
    comma { ctx.validation = { ok: false, error: "$msg" } }
  }
}

