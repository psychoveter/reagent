// Example 02: Await + timeout + alt (XOR)
// Intent: comma submits intent to sia; waits for either Accept or Reject within timeout.
// If timeout → fallback branch.
// Roles: comma, sia
//
// Required acts: await, timeout, alt.
//
// NOTE: syntax is provisional; this example is here to drive design.

protocol AwaitTimeoutAlt {
  participants: comma, sia
  initiator: comma
  input: SubmitIntent

  comma --> sia: SubmitIntent = {
    onSend: { call: "comma.sendIntent", args: { intent: "$ctx.intent" } }
  }

  alt (sia --> comma: Accept = { }) {
    comma {
      // happy path
      ctx.status = "accepted"
    }
  } else (sia --> comma: Reject = { }) {
    comma {
      ctx.status = "rejected"
    }
  } else (timeout 10s) {
    comma {
      ctx.status = "timeout"
    }
  }
}

