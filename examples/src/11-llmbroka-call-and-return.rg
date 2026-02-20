// Example 11: calling llmbroka and returning a value
// Uses protocol-level invoke for the child LLM call.

message TaskRequest {}
message Greeting {}
message LlmPlan {}

import "./lib/call-llm.rg" as llm

protocol CommaAsksLlmAndReplies {
  participants: user [ts], comma [ts], llmbroka [*]
  initiator: user
  input: TaskRequest

  user {
    $flow.taskText = $ctx.input.text
  }
  user --> comma: TaskRequest = { }

  comma --> user: Greeting = { }

  comma {
    $ctx.llmReq = {
      system: "You are Comma. Be concise and correct.",
      user: "Rewrite this task as a precise plan:\n\n" + $flow.taskText,
      model: "gpt-5.2",
      temperature: 0.2
    }
  }

  invoke llm.CallLlm($ctx.llmReq) as comma {
    llmbroka: llmbroka
  } -> $flow.llmAnswer

  comma --> user: LlmPlan = {
    onSend {
      $ctx.msg.text = $flow.llmAnswer
    }
  }
}
