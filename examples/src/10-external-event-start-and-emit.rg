// Example 10: protocol start by external input (unknown sender) + emitting events
//
// Requirement:
// - protocol starts on an external input message (unknown sender)
// - events can be emitted outward (via reagent.emit() inside an agent zone)

message SubmitIntent {}

protocol TaskExecutionFromEvent {
  participants: comma [ts], sia [*]
  initiator: comma
  input: TaskRequested

  comma {
    $ctx.taskText = $ctx.input.text
  }

  comma --> sia: SubmitIntent = { }

  // Emit event outward for tracing/observability/other agents.
  comma {
    reagent.emit("TaskSubmitted", { kind: "task.submitted", ref: $ctx.intent })
  }
}
