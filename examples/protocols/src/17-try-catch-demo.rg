// Example 17: try/catch demo for runtime E2E tests
// Data crosses roles via $ctx.msg (onSend/onReceive). $ctx is per-role.

message Request {}
message Result {}
message Failure {}

protocol TryCatchDemo {
  participants:
    sender [ts] initiator,
    processor [ts]
  trigger on invoke with Request {
    resolve sender = single
    resolve processor = single
  }

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
