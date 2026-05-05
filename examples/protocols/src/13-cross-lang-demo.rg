// Example 13: cross-language demo (TypeScript browser + Python server)
// $ctx carries data between roles across language boundaries.

message Query {}
message Accept {}
message Reject {}

protocol CrossLangDemo {
  participants:
    browser [ts] initiator,
    server [py]
  trigger on invoke with UserQuery {
    resolve browser = single
    resolve server = single
  }

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
    $ctx.result = process_query($ctx.queryText)
    $self.queriesHandled += 1
  }

  alt at server ($ctx.result.status == "ok") {
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
