// Library protocol: multi-party child protocol (comma ↔ sia)
//
// Intent: comma asks sia to validate an intent; sia replies OK or Error.
// This protocol is meant to be *invoked* from a parent protocol.

message ValidateIntent {}
message ValidationOk {}
message ValidationError {}

protocol ValidateIntentWithSia {
  participants: comma [ts], sia [*]
  initiator: comma
  input: ValidateIntent

  comma --> sia: ValidateIntent = {
    onSend {
      $ctx.msg.ref = $ctx.intent
    }
  }

  alt (sia --> comma: ValidationOk = { }) {
    comma { $ctx.validation = { ok: true } }
  } else (sia --> comma: ValidationError = { }) {
    comma { $ctx.validation = { ok: false, error: $ctx.msg } }
  }

  comma {
    reagent.return($ctx.validation)
  }
}
