message ValidateIntent {}
message ValidationOk {}
message ValidationError {}

// Example 03: loop + retry/backoff
// Intent: comma asks sia to validate DSI/BSI; retries up to N times with backoff on transient failure.
// Uses `where` keyword for pattern matching in alt guards.
// reagent.break() is the explicit break sentinel visible to the IR.

protocol LoopRetryBackoff {
  participants:
    comma [ts] initiator,
    sia [*]
  trigger on invoke with ValidateIntent {
    resolve comma = single
    resolve sia = single
  }

  comma {
    $ctx.attempt = 0
  }

  loop ($ctx.attempt < 3) {
    comma --> sia: ValidateIntent = {
      onSend {
        $ctx.msg.ref = $ctx.intent
      }
    }

    alt at comma (sia --> comma: ValidationOk) {
      comma { $ctx.valid = true }
      comma { reagent.break() }
    } else (sia --> comma: ValidationError where { code: "TRANSIENT" }) {
      comma { $ctx.attempt = $ctx.attempt + 1 }
      wait 1s
    } else (sia --> comma: ValidationError where { code: "FATAL" }) {
      comma { throw "fatal_validation_error" }
    }
  }
}

role CommaRole [ts] {
  plays LoopRetryBackoff as comma
}

role SiaRole [*] {
  plays LoopRetryBackoff as sia
}

agent Comma runs CommaRole
agent Sia runs SiaRole
