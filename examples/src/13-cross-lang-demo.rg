// Example 13: cross-language demo (TypeScript browser + Python server)
//
// Demonstrates:
// - Two roles in different languages participating in one protocol
// - Role definitions with $self state, init, lifecycle handlers
// - Alt branching based on server-side processing result
// - onSend hooks for payload construction

message Query {}
message Accept {}
message Reject {}

protocol CrossLangDemo {
  participants: browser [ts], server [py]
  initiator: browser
  input: UserQuery

  browser {
    $ctx.queryText = $ctx.input.text
  }

  browser --> server: Query = {
    onSend {
      $ctx.msg.text = $ctx.queryText
    }
    onReceive {
      $ctx.queryText = $ctx.msg.text
    }
  }

  server {
    result = process_query($ctx.queryText)
    $ctx.result = result
    $self.queriesHandled += 1
  }

  alt ($ctx.result.status == "ok") {
    server --> browser: Accept = {
      onSend {
        $ctx.msg.data = $ctx.result.data
      }
      onReceive {
        $ctx.responseData = $ctx.msg.data
      }
    }
  } else {
    server --> browser: Reject = {
      onSend {
        $ctx.msg.reason = $ctx.result.reason
      }
      onReceive {
        $ctx.rejectReason = $ctx.msg.reason
      }
    }
  }
}

role BrowserRole [ts] {
  plays CrossLangDemo as browser

  init {
    $self.ready = true
    $self.responsesReceived = 0
  }

  on protocolCompleted(CrossLangDemo) {
    $self.responsesReceived += 1
  }
}

role ServerRole [py] {
  plays CrossLangDemo as server

  init {
    $self.queriesHandled = 0
  }

  on protocolCompleted(CrossLangDemo) {
    $self.lastCompletedAt = Date.now()
  }
}

agent BrowserAgent runs BrowserRole
agent ServerAgent runs ServerRole
