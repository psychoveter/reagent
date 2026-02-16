// Library protocol: request/response with llmbroka (LLM gateway angel)
//
// Intent:
// - Any agent can call an LLM through a dedicated participant `llmbroka`.
// - Caller composes a prompt and sends it to llmbroka.
// - llmbroka returns a response message.
// - Protocol returns the response value to the invoker.
//
// NOTE:
// - `return` is reserved syntax (examples-first). It models producing an output value
//   from the protocol instance for the parent `invoke` to consume.

protocol CallLlm {
  participants: caller, llmbroka
  initiator: caller
  input: LlmRequest

  caller {
    // $input is the external input delivered to initiator (caller).
    // Expected shape (example): { system: "...", user: "...", model: "gpt-...", temperature: 0.2 }
    ctx.req = $input
    ctx.prompt = [
      { role: "system", content: ctx.req.system },
      { role: "user", content: ctx.req.user }
    ]
  }

  caller --> llmbroka: LlmPrompt = {
    onSend: { 
      call: "llm.send", 
      args: { 
        model: "$ctx.req.model", 
        messages: "$ctx.prompt", 
        temperature: "$ctx.req.temperature" 
      },
      onReceive: { 
        call: "caller.onLlmAnswer", 
        args: { text: "$msg.text" } 
      }
    }
  }

  llmbroka --> caller: LlmAnswer = {
    onReceive: { 
      call: "caller.onLlmAnswer", 
      args: { text: "$msg.text" } 
    }
  }

  caller {
    ctx.answer = $msg.text
  }

  return ctx.answer
}

