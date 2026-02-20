// Library protocol: request/response with llmbroka (LLM gateway angel)
//
// Caller composes a prompt and sends it to llmbroka.
// llmbroka returns a response. Protocol returns the response via reagent.return().

message LlmPrompt {}
message LlmAnswer {}

protocol CallLlm {
  participants: caller [ts], llmbroka [ts]
  initiator: caller
  input: LlmRequest

  caller {
    $ctx.req = $ctx.input
    $ctx.prompt = [
      { role: "system", content: $ctx.req.system },
      { role: "user", content: $ctx.req.user }
    ]
  }

  caller --> llmbroka: LlmPrompt = {
    onSend {
      $ctx.msg.model = $ctx.req.model
      $ctx.msg.messages = $ctx.prompt
      $ctx.msg.temperature = $ctx.req.temperature
    }
    onReceive {
      $ctx.model = $ctx.msg.model
      $ctx.messages = $ctx.msg.messages
    }
  }

  llmbroka --> caller: LlmAnswer = {
    onReceive {
      $ctx.answer = $ctx.msg.text
    }
  }

  caller {
    reagent.return($ctx.answer)
  }
}
