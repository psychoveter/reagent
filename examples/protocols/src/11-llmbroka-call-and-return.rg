// Example 11: calling llmbroka and returning a value
// Uses protocol-level invokes for the child LLM call.

message TaskRequest {}
message Greeting {}
message LlmPlan {}

import "./lib/call-llm.rg" as llm

protocol CommaAsksLlmAndReplies {
  participants:
    user [ts] initiator,
    comma [ts],
    llmbroka [*]
  trigger on invoke with TaskRequest {
    resolve user = single
    resolve comma = single
    resolve llmbroka = single
  }

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

role UserRole [ts] {
  plays CommaAsksLlmAndReplies as user
}

role CommaRole [ts] {
  plays CommaAsksLlmAndReplies as comma
}

role LlmbrokaRole [*] {
  plays CommaAsksLlmAndReplies as llmbroka
}

agent User runs UserRole
agent Comma runs CommaRole
agent Llmbroka runs LlmbrokaRole
