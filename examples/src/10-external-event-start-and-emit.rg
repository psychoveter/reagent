// Example 10: protocol start by external input (unknown sender) + emitting events

message SubmitIntent {}

protocol TaskExecutionFromEvent {
  participants: comma [ts], sia [*]
  initiator: comma
  input: TaskRequested

  comma {
    $flow.taskText = $ctx.input.text
  }

  comma --> sia: SubmitIntent = { }

  comma {
    reagent.emit("TaskSubmitted", { kind: "task.submitted", ref: $flow.intent })
  }
}
