// Library protocol: multi-party child protocol (comma ↔ sia)
// Comma asks sia to validate an intent; sia replies OK or Error.
// Uses `where` for alt guard pattern matching.

message ValidateIntent {}
message ValidationOk {}
message ValidationError {}

protocol ValidateIntentWithSia {
  participants: comma [ts], sia [*]
  initiator: comma
  input: ValidateIntent

  comma --> sia: ValidateIntent = {
    onSend {
      $ctx.msg.ref = $flow.intent
    }
  }

  alt (sia --> comma: ValidationOk) {
    comma { $ctx.validation = { ok: true } }
  } else (sia --> comma: ValidationError) {
    comma { $ctx.validation = { ok: false, error: $ctx.msg } }
  }

  comma {
    reagent.return($ctx.validation)
  }
}
