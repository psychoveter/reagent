message SubmitIntent {}
message Accept {}
message Reject {}

// Example 02: Await + timeout + alt (XOR)
// Intent: comma submits intent to sia; waits for either Accept or Reject within timeout.
// If timeout → fallback branch.
// Roles: comma [ts], sia [ts]
//
// Required acts: await, timeout, alt.
// alt = message-based branching (reactive). NOT condition-based (that's host-language in zone).

protocol AwaitTimeoutAlt {
  participants: comma [ts], sia [*]
  initiator: comma
  input: SubmitIntent

  comma --> sia: SubmitIntent = {
    onSend {
      $ctx.msg.intent = $ctx.intent
    }
  }

  alt (sia --> comma: Accept = { }) {
    comma {
      $ctx.status = "accepted"
    }
  } else (sia --> comma: Reject = { }) {
    comma {
      $ctx.status = "rejected"
    }
  } else (timeout 10s) {
    comma {
      $ctx.status = "timeout"
    }
  }
}
