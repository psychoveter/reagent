// Example 14: TS-only demo for runtime E2E tests
//
// Both roles are TypeScript. Used for:
//   T1: linear protocol
//   T2: alt-accept path
//   T3: alt-reject path
//   T5: $self state across multiple instances

message Query {}
message Accept {}
message Reject {}

protocol TsDemo {
  participants: client [ts], handler [ts]
  initiator: client
  input: Request

  client {
    $ctx.queryText = $ctx.input.text
  }

  client --> handler: Query = {
    onSend {
      $ctx.msg.text = $ctx.queryText
    }
    onReceive {
      $ctx.queryText = $ctx.msg.text
    }
  }

  handler {
    $ctx.result = { status: $ctx.queryText === "fail" ? "error" : "ok", data: "processed:" + $ctx.queryText }
    $self.queriesHandled = ($self.queriesHandled || 0) + 1
  }

  alt ($ctx.result.status == "ok") {
    handler --> client: Accept = {
      onSend {
        $ctx.msg.data = $ctx.result.data
      }
      onReceive {
        $ctx.responseData = $ctx.msg.data
      }
    }
  } else {
    handler --> client: Reject = {
      onSend {
        $ctx.msg.reason = "query_failed"
      }
      onReceive {
        $ctx.rejectReason = $ctx.msg.reason
      }
    }
  }
}

role ClientRole [ts] {
  plays TsDemo as client

  init {
    $self.ready = true
    $self.responsesReceived = 0
  }

  on protocolCompleted(TsDemo) {
    $self.responsesReceived = ($self.responsesReceived || 0) + 1
  }
}

role HandlerRole [ts] {
  plays TsDemo as handler

  init {
    $self.queriesHandled = 0
  }

  on protocolCompleted(TsDemo) {
    $self.lastCompletedAt = Date.now()
  }
}

agent ClientAgent runs ClientRole
agent HandlerAgent runs HandlerRole
