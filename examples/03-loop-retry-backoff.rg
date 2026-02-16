// Example 03: loop + retry/backoff
// Intent: comma asks sia to validate DSI/BSI; retries up to N times with backoff on transient failure.
// Roles: comma, sia
//
// Required acts: loop, guards/predicates, delays/timers.

protocol LoopRetryBackoff {
  participants: comma, sia
  initiator: comma
  input: ValidateIntent

  comma {
    ctx.attempt = 0
  }

  loop (ctx.attempt < 3) {
    comma --> sia: ValidateIntent = {
      onSend: { call: "comma.sendForValidation", args: { ref: "$ctx.intent" } }
    }

    alt (sia --> comma: ValidationOk = { }) {
      comma { ctx.valid = true }
      break
    } else (sia --> comma: ValidationError = { code: "TRANSIENT" }) {
      comma { ctx.attempt = ctx.attempt + 1 }
      wait 1s
    } else (sia --> comma: ValidationError = { code: "FATAL" }) {
      comma { throw "fatal_validation_error" }
    }
  }
}

