// Example 11: base protocol for calling llmbroka and returning a value
//
// Requirement:
// - Provide a canonical protocol for "agent calls LLM" via participant `llmbroka`.
// - Support returning a value from invoked protocol back to the caller.
//
// Semantics we want to capture:
// - Parent protocol invokes `CallLlm` with input args.
// - Child protocol returns `string` answer.
// - Parent receives that answer as a local binding and can send it onward.

import "./lib/call-llm.rg" as llm

protocol CommaAsksLlmAndReplies {
  participants: user, comma, llmbroka
  initiator: user
  input: TaskRequest

  user { ctx.taskText = $input.text }

  comma --> user: Greeting = { }

  // Compose prompt and call LLM.
  comma {
    ctx.llmReq = {
      system: "You are Comma. Be concise and correct.",
      user: "Rewrite this task as a precise plan:\\n\\n" + ctx.taskText,
      model: "gpt-5.2",
      temperature: 0.2
    }
  }

  invoke llm.CallLlm = {
    // Map parent -> child roles.
    roles: { caller: "comma", llmbroka: "llmbroka" },
    input: "$ctx.llmReq",
    // Return binding in parent:
    out: "llmAnswer"
  }

  comma --> user: LlmPlan = {
    onSend: { call: "comma.replyWithPlan", args: { text: "$ctx.llmAnswer" } }
  }
}

