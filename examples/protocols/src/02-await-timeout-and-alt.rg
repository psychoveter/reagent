message SubmitIntent {}
message Accept {}
message Reject {}

// Example 02: Await + timeout + alt (XOR)
// Intent: comma submits intent to sia; waits for either Accept or Reject within timeout.
// If timeout → fallback branch.
// Uses `where` keyword for pattern matching in alt guards.

protocol AwaitTimeoutAlt {
  participants:
    comma [ts] initiator,
    sia [*]
  trigger on invoke with SubmitIntent {
    resolve comma = single
    resolve sia = single
  }

  comma --> sia: SubmitIntent = {
    onSend {
      $ctx.msg.intent = $ctx.intent
    }
  }

  alt (sia --> comma: Accept) {
    comma {
      $ctx.status = "accepted"
    }
  } else (sia --> comma: Reject) {
    comma {
      $ctx.status = "rejected"
    }
  } else (timeout 10s) {
    comma {
      $ctx.status = "timeout"
    }
  }
}

role CommaRole [ts] {
  plays AwaitTimeoutAlt as comma
}

role SiaRole [*] {
  plays AwaitTimeoutAlt as sia
}

agent Comma runs CommaRole
agent Sia runs SiaRole
