// Library protocol: multi-party child protocol (comma ↔ sia)
// Comma asks sia to validate an intent; sia replies OK or Error.
// Uses `where` for alt guard pattern matching.

message ValidateIntent {}
message ValidationOk {}
message ValidationError {}

protocol ValidateIntentWithSia {
  participants:
    comma [ts] initiator,
    sia [*]
  trigger on invoke with ValidateIntent {
    resolve comma = single
    resolve sia = single
  }

  comma --> sia: ValidateIntent = {
    onSend {
      $ctx.msg.ref = $ctx.intent
    }
  }

  alt at comma (sia --> comma: ValidationOk) {
    comma { $ctx.validation = { ok: true } }
  } else (sia --> comma: ValidationError) {
    comma { $ctx.validation = { ok: false, error: $ctx.msg } }
  }

  comma {
    reagent.return($ctx.validation)
  }
}
