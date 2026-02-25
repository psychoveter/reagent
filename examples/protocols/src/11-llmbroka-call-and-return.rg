// Example 11: calling llmbroka and returning a value
// Uses protocol-level invokes for the child LLM call.

message TaskRequest {}
message Greeting {}
message LlmPlan {}

import "./lib/call-llm.rg" as llm

protocol CommaAsksLlmAndReplies {
  participants: user [ts], comma [ts], llmbroka [*]
  initiator: user
  input: TaskRequest

  user {
    $ctx.taskText = $ctx.input.text
  }
  user --> comma: TaskRequest = { }

  comma --> user: Greeting = { }

  comma {
    $ctx.llmReq = {
      system: "You are Comma. Be concise and correct.",
      user: "Rewrite this task as a precise plan:\n\n" + $ctx.taskText,
      model: "gpt-5.2",
      temperature: 0.2
    }
  }

  comma invokes llm.CallLlm($ctx.llmReq) {
    llmbroka: llmbroka
  } -> $ctx.llmAnswer

  comma --> user: LlmPlan = {
    onSend {
      $ctx.msg.text = $ctx.llmAnswer
    }
  }
}
