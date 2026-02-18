// Example 20: cross-language E2E (TypeScript ↔ Python)
//
// A TS agent and a Python agent exchange messages over NATS.
// No opaque function calls — only $ctx/$self operations.

protocol CrossLangE2E {
  participants: tsRole [ts], pyRole [py]
  initiator: tsRole

  tsRole {
    $ctx.greeting = "hello from ts"
  }

  tsRole --> pyRole: Greeting = {
    onSend {
      $ctx.msg.text = $ctx.greeting
    }
    onReceive {
      $ctx.receivedGreeting = $ctx.msg.text
    }
  }

  pyRole {
    $ctx.reply = $ctx.receivedGreeting + " — echoed by py"
    $self.messagesProcessed = ($self.messagesProcessed or 0) + 1
  }

  pyRole --> tsRole: Reply = {
    onSend {
      $ctx.msg.text = $ctx.reply
    }
    onReceive {
      $ctx.replyText = $ctx.msg.text
      $self.lastReply = $ctx.msg.text
    }
  }
}

agent TsAgent [ts] {
  plays CrossLangE2E as tsRole

  init {
    $self.lastReply = ""
  }
}

agent PyAgent [py] {
  plays CrossLangE2E as pyRole

  init {
    $self.messagesProcessed = 0
  }

  on protocolCompleted(CrossLangE2E) {
    $self.completedCount = ($self.completedCount or 0) + 1
  }
}
