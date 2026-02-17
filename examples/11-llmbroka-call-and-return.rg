// Example 11: base protocol for calling llmbroka and returning a value
//
// Requirement:
// - Provide a canonical protocol for "agent calls LLM" via participant `llmbroka`.
// - Support returning a value from invoked protocol back to the caller.
//
// Semantics:
// - Parent protocol invokes `CallLlm` with reagent.invoke() from agent zone.
// - Child protocol returns answer via reagent.return().
// - Parent receives that answer as a local $ctx binding.

import "./lib/call-llm.rg" as llm

protocol CommaAsksLlmAndReplies {
  participants: user [ts], comma [ts], llmbroka [ts]
  initiator: user
  input: TaskRequest

  user { $ctx.taskText = $ctx.input.text }
  user --> comma: TaskRequest = { }

  comma --> user: Greeting = { }

  comma {
    $ctx.llmReq = {
      system: "You are Comma. Be concise and correct.",
      user: "Rewrite this task as a precise plan:\n\n" + $ctx.taskText,
      model: "gpt-5.2",
      temperature: 0.2
    }
    $ctx.llmAnswer = reagent.invoke(llm.CallLlm, { llmbroka: llmbroka }, $ctx.llmReq)
  }

  comma --> user: LlmPlan = {
    onSend {
      $ctx.msg.text = $ctx.llmAnswer
    }
  }
}
