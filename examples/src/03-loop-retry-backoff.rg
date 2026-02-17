// Example 03: loop + retry/backoff
// Intent: comma asks sia to validate DSI/BSI; retries up to N times with backoff on transient failure.
// Roles: comma [ts], sia [ts]
//
// Required acts: loop, alt (message-based), wait.
// loop guard is a $ctx expression evaluated by runtime.
// break/throw inside zones are host-language constructs bridged by the reagent runtime library.

protocol LoopRetryBackoff {
  participants: comma [ts], sia [ts]
  initiator: comma
  input: ValidateIntent

  comma {
    $ctx.attempt = 0
  }

  loop ($ctx.attempt < 3) {
    comma --> sia: ValidateIntent = {
      onSend {
        $ctx.msg.ref = $ctx.intent
      }
    }

    alt (sia --> comma: ValidationOk = { }) {
      comma { $ctx.valid = true }
      break
    } else (sia --> comma: ValidationError = { code: "TRANSIENT" }) {
      comma { $ctx.attempt = $ctx.attempt + 1 }
      wait 1s
    } else (sia --> comma: ValidationError = { code: "FATAL" }) {
      comma { throw "fatal_validation_error" }
    }
  }
}
