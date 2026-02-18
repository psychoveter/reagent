// Example 17: try/catch demo for runtime E2E tests
//
// Tests:
//   T11: Zone throws → catch block executes → protocol completes
//   T12: No error → try body completes normally, catch skipped
//
// Protocol: sender sends a request to processor.
// If input says "fail", processor throws in the try body.
// Catch block sends a Failure message. Otherwise normal Result message.

message Request {}
message Result {}
message Failure {}

protocol TryCatchDemo {
  participants: sender [ts], processor [ts]
  initiator: sender
  input: Request

  sender {
    $ctx.requestText = $ctx.input.text
  }

  sender --> processor: Request = {
    onSend {
      $ctx.msg.text = $ctx.requestText
    }
    onReceive {
      $ctx.requestText = $ctx.msg.text
    }
  }

  try {
    processor {
      if ($ctx.requestText === "fail") {
        throw new Error("processing_failed")
      }
      $ctx.result = "processed:" + $ctx.requestText
    }

    processor --> sender: Result = {
      onSend {
        $ctx.msg.data = $ctx.result
      }
      onReceive {
        $ctx.responseData = $ctx.msg.data
        $self.successCount = ($self.successCount || 0) + 1
      }
    }
  } catch (error) {
    processor {
      $ctx.errorMsg = "error occurred"
    }

    processor --> sender: Failure = {
      onSend {
        $ctx.msg.reason = $ctx.errorMsg
      }
      onReceive {
        $ctx.failureReason = $ctx.msg.reason
        $self.failureCount = ($self.failureCount || 0) + 1
      }
    }
  }
}

role SenderRole [ts] {
  plays TryCatchDemo as sender

  init {
    $self.successCount = 0
    $self.failureCount = 0
  }

  on protocolCompleted(TryCatchDemo) {
    $self.lastCompletedAt = Date.now()
  }
}

role ProcessorRole [ts] {
  plays TryCatchDemo as processor

  init {
    $self.processed = 0
  }

  on protocolCompleted(TryCatchDemo) {
    $self.processed = ($self.processed || 0) + 1
  }
}

agent SenderAgent runs SenderRole
agent ProcessorAgent runs ProcessorRole
