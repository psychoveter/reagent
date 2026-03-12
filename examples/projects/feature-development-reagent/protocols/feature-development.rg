// Feature development workflow for Reagent itself.
//
// Roles:
//   human      — product owner / approver via Cursor MCP
//   analyst    — formalizes task and updates product/user/spec docs
//   developer  — produces architecture design, code, and tests
//   reviewer   — reviews analyst and developer outputs
//
// Three staged child protocols:
//   1. DesignStage
//   2. ImplementationStage
//   3. FinalizationStage
//
// Each stage runs its own analyst/developer/reviewer loop until the human approves.

message FeatureTask {
  title: string
  problem: string
  goals: any
  constraints: any
  acceptance: any
}

message StageInput {
  stage: string
  task: any
  previous: any
}

message DesignPacket {
  stage: string
  docsDelta: any
  architecture: any
  openQuestions: any
  revisionNote: any
}

message ImplementationPacket {
  stage: string
  changeSet: any
  tests: any
  architectureNotes: any
  revisionNote: any
}

message FinalizationPacket {
  stage: string
  docUpdates: any
  backlogUpdates: any
  releaseNotes: any
  revisionNote: any
}

message ReviewFeedback {
  approvedForHuman: boolean
  summary: string
  findings: any
  requestedChanges: any
}

message ApprovalRequest {
  stage: string
  artifact: any
  review: any
}

message ApprovalDecision {
  approved: boolean
  comment: string
  requestedChanges: any
}

message StageOutcome {
  stage: string
  status: string
  artifact: any
  humanDecision: any
}

message FeatureDevelopmentResult {
  design: any
  implementation: any
  finalization: any
}

protocol DesignStage {
  participants:
    human [ts] initiator,
    analyst [ts],
    developer [ts],
    reviewer [ts]

  trigger on invoke with FeatureTask {
    resolve human = single
    resolve analyst = single
    resolve developer = single
    resolve reviewer = single
  }

  human --> analyst: FeatureTask = {
    onReceive {
      $ctx.task = $ctx.msg
      $ctx.iteration = 0
      $ctx.stageApproved = false
      $ctx.pendingChanges = null
    }
  }

  loop ($ctx.stageApproved != true) {
    analyst {
      $ctx.iteration = $ctx.iteration + 1
      $ctx.designDraft = {
        stage: "design",
        docsDelta: {
          product: "updated problem statement for " + $ctx.task.title,
          user: "updated user-facing behavior notes",
          spec: "updated technical spec revision " + $ctx.iteration
        },
        architecture: {
          components: ["protocol", "roles", "tooling"],
          decision: "analyst formalized the problem and prepared design input"
        },
        openQuestions: [],
        revisionNote: $ctx.pendingChanges
      }
    }

    analyst --> developer: DesignPacket = {
      onSend {
        $ctx.msg.stage = $ctx.designDraft.stage
        $ctx.msg.docsDelta = $ctx.designDraft.docsDelta
        $ctx.msg.architecture = $ctx.designDraft.architecture
        $ctx.msg.openQuestions = $ctx.designDraft.openQuestions
        $ctx.msg.revisionNote = $ctx.designDraft.revisionNote
      }
      onReceive {
        $ctx.designInput = $ctx.msg
      }
    }

    developer {
      $ctx.designProposal = {
        stage: "design",
        docsDelta: $ctx.designInput.docsDelta,
        architecture: {
          designDoc: "developer architecture proposal for " + $ctx.task.title,
          boundaries: ["runtime", "docs", "tests"]
        },
        openQuestions: $ctx.designInput.openQuestions,
        revisionNote: $ctx.designInput.revisionNote
      }
    }

    developer --> reviewer: DesignPacket = {
      onSend {
        $ctx.msg.stage = $ctx.designProposal.stage
        $ctx.msg.docsDelta = $ctx.designProposal.docsDelta
        $ctx.msg.architecture = $ctx.designProposal.architecture
        $ctx.msg.openQuestions = $ctx.designProposal.openQuestions
        $ctx.msg.revisionNote = $ctx.designProposal.revisionNote
      }
      onReceive {
        $ctx.reviewTarget = $ctx.msg
      }
    }

    reviewer {
      $ctx.review = {
        approvedForHuman: true,
        summary: "design reviewed",
        findings: [],
        requestedChanges: []
      }
    }

    reviewer --> analyst: ReviewFeedback = {
      onSend {
        $ctx.msg.approvedForHuman = $ctx.review.approvedForHuman
        $ctx.msg.summary = $ctx.review.summary
        $ctx.msg.findings = $ctx.review.findings
        $ctx.msg.requestedChanges = $ctx.review.requestedChanges
      }
      onReceive {
        $ctx.reviewFeedback = $ctx.msg
      }
    }

    analyst --> human: ApprovalRequest = {
      onSend {
        $ctx.msg.stage = "design"
        $ctx.msg.artifact = $ctx.designProposal
        $ctx.msg.review = $ctx.reviewFeedback
      }
      onReceive {
        $ctx.approvalRequest = $ctx.msg
      }
    }

    human {
      $ctx.decision = await $agent.approve_stage($ctx.approvalRequest)
    }

    human --> analyst: ApprovalDecision = {
      onSend {
        $ctx.msg.approved = $ctx.decision.approved
        $ctx.msg.comment = $ctx.decision.comment
        $ctx.msg.requestedChanges = $ctx.decision.requestedChanges
      }
      onReceive {
        $ctx.stageApproved = $ctx.msg.approved
        $ctx.pendingChanges = $ctx.msg.requestedChanges
        $ctx.lastDecision = $ctx.msg
      }
    }

    alt ($ctx.stageApproved == true) {
      analyst {
        reagent.return({
          stage: "design",
          status: "approved",
          artifact: $ctx.designProposal,
          humanDecision: $ctx.lastDecision
        })
      }
    } else {
      analyst {
        $ctx.pendingChanges = $ctx.lastDecision.requestedChanges
      }
    }
  }
}

protocol ImplementationStage {
  participants:
    human [ts] initiator,
    analyst [ts],
    developer [ts],
    reviewer [ts]

  trigger on invoke with StageInput {
    resolve human = single
    resolve analyst = single
    resolve developer = single
    resolve reviewer = single
  }

  human --> developer: StageInput = {
    onReceive {
      $ctx.task = $ctx.msg.task
      $ctx.design = $ctx.msg.previous
      $ctx.iteration = 0
      $ctx.stageApproved = false
      $ctx.pendingChanges = null
    }
  }

  loop ($ctx.stageApproved != true) {
    developer {
      $ctx.iteration = $ctx.iteration + 1
      $ctx.implementationDraft = {
        stage: "implementation",
        changeSet: {
          code: ["runtime change", "test change"],
          tests: ["focused regression suite"],
          derivedFrom: $ctx.design.artifact
        },
        tests: ["unit", "integration", "focused e2e"],
        architectureNotes: {
          why: "developer aligned implementation with approved design",
          revision: $ctx.iteration
        },
        revisionNote: $ctx.pendingChanges
      }
    }

    developer --> reviewer: ImplementationPacket = {
      onSend {
        $ctx.msg.stage = $ctx.implementationDraft.stage
        $ctx.msg.changeSet = $ctx.implementationDraft.changeSet
        $ctx.msg.tests = $ctx.implementationDraft.tests
        $ctx.msg.architectureNotes = $ctx.implementationDraft.architectureNotes
        $ctx.msg.revisionNote = $ctx.implementationDraft.revisionNote
      }
      onReceive {
        $ctx.reviewTarget = $ctx.msg
      }
    }

    reviewer {
      $ctx.review = {
        approvedForHuman: true,
        summary: "implementation reviewed",
        findings: [],
        requestedChanges: []
      }
    }

    reviewer --> analyst: ReviewFeedback = {
      onSend {
        $ctx.msg.approvedForHuman = $ctx.review.approvedForHuman
        $ctx.msg.summary = $ctx.review.summary
        $ctx.msg.findings = $ctx.review.findings
        $ctx.msg.requestedChanges = $ctx.review.requestedChanges
      }
      onReceive {
        $ctx.reviewFeedback = $ctx.msg
      }
    }

    analyst {
      $ctx.implSummary = {
        stage: "implementation",
        changeSet: $ctx.reviewTarget.changeSet,
        tests: $ctx.reviewTarget.tests,
        architectureNotes: $ctx.reviewTarget.architectureNotes,
        revisionNote: $ctx.reviewFeedback.requestedChanges
      }
    }

    analyst --> human: ApprovalRequest = {
      onSend {
        $ctx.msg.stage = "implementation"
        $ctx.msg.artifact = $ctx.implSummary
        $ctx.msg.review = $ctx.reviewFeedback
      }
      onReceive {
        $ctx.approvalRequest = $ctx.msg
      }
    }

    human {
      $ctx.decision = await $agent.approve_stage($ctx.approvalRequest)
    }

    human --> analyst: ApprovalDecision = {
      onSend {
        $ctx.msg.approved = $ctx.decision.approved
        $ctx.msg.comment = $ctx.decision.comment
        $ctx.msg.requestedChanges = $ctx.decision.requestedChanges
      }
      onReceive {
        $ctx.stageApproved = $ctx.msg.approved
        $ctx.pendingChanges = $ctx.msg.requestedChanges
        $ctx.lastDecision = $ctx.msg
      }
    }

    alt ($ctx.stageApproved == true) {
      analyst {
        reagent.return({
          stage: "implementation",
          status: "approved",
          artifact: $ctx.implSummary,
          humanDecision: $ctx.lastDecision
        })
      }
    } else {
      developer {
        $ctx.pendingChanges = $ctx.lastDecision.requestedChanges
      }
    }
  }
}

protocol FinalizationStage {
  participants:
    human [ts] initiator,
    analyst [ts],
    developer [ts],
    reviewer [ts]

  trigger on invoke with StageInput {
    resolve human = single
    resolve analyst = single
    resolve developer = single
    resolve reviewer = single
  }

  human --> analyst: StageInput = {
    onReceive {
      $ctx.task = $ctx.msg.task
      $ctx.previous = $ctx.msg.previous
      $ctx.iteration = 0
      $ctx.stageApproved = false
      $ctx.pendingChanges = null
    }
  }

  loop ($ctx.stageApproved != true) {
    analyst {
      $ctx.iteration = $ctx.iteration + 1
      $ctx.finalDraft = {
        stage: "finalization",
        docUpdates: {
          product: "updated product docs for " + $ctx.task.title,
          user: "updated user guide",
          spec: "updated implementation and acceptance notes"
        },
        backlogUpdates: {
          closed: ["implementation task"],
          followUps: ["future improvements", "deferred work"]
        },
        releaseNotes: {
          summary: "feature finalized",
          revision: $ctx.iteration
        },
        revisionNote: $ctx.pendingChanges
      }
    }

    analyst --> developer: FinalizationPacket = {
      onSend {
        $ctx.msg.stage = $ctx.finalDraft.stage
        $ctx.msg.docUpdates = $ctx.finalDraft.docUpdates
        $ctx.msg.backlogUpdates = $ctx.finalDraft.backlogUpdates
        $ctx.msg.releaseNotes = $ctx.finalDraft.releaseNotes
        $ctx.msg.revisionNote = $ctx.finalDraft.revisionNote
      }
      onReceive {
        $ctx.finalizationInput = $ctx.msg
      }
    }

    developer {
      $ctx.finalPacket = {
        stage: "finalization",
        docUpdates: $ctx.finalizationInput.docUpdates,
        backlogUpdates: $ctx.finalizationInput.backlogUpdates,
        releaseNotes: $ctx.finalizationInput.releaseNotes,
        revisionNote: $ctx.finalizationInput.revisionNote
      }
    }

    developer --> reviewer: FinalizationPacket = {
      onSend {
        $ctx.msg.stage = $ctx.finalPacket.stage
        $ctx.msg.docUpdates = $ctx.finalPacket.docUpdates
        $ctx.msg.backlogUpdates = $ctx.finalPacket.backlogUpdates
        $ctx.msg.releaseNotes = $ctx.finalPacket.releaseNotes
        $ctx.msg.revisionNote = $ctx.finalPacket.revisionNote
      }
      onReceive {
        $ctx.reviewTarget = $ctx.msg
      }
    }

    reviewer {
      $ctx.review = {
        approvedForHuman: true,
        summary: "finalization reviewed",
        findings: [],
        requestedChanges: []
      }
    }

    reviewer --> analyst: ReviewFeedback = {
      onSend {
        $ctx.msg.approvedForHuman = $ctx.review.approvedForHuman
        $ctx.msg.summary = $ctx.review.summary
        $ctx.msg.findings = $ctx.review.findings
        $ctx.msg.requestedChanges = $ctx.review.requestedChanges
      }
      onReceive {
        $ctx.reviewFeedback = $ctx.msg
      }
    }

    analyst --> human: ApprovalRequest = {
      onSend {
        $ctx.msg.stage = "finalization"
        $ctx.msg.artifact = $ctx.finalPacket
        $ctx.msg.review = $ctx.reviewFeedback
      }
      onReceive {
        $ctx.approvalRequest = $ctx.msg
      }
    }

    human {
      $ctx.decision = await $agent.approve_stage($ctx.approvalRequest)
    }

    human --> analyst: ApprovalDecision = {
      onSend {
        $ctx.msg.approved = $ctx.decision.approved
        $ctx.msg.comment = $ctx.decision.comment
        $ctx.msg.requestedChanges = $ctx.decision.requestedChanges
      }
      onReceive {
        $ctx.stageApproved = $ctx.msg.approved
        $ctx.pendingChanges = $ctx.msg.requestedChanges
        $ctx.lastDecision = $ctx.msg
      }
    }

    alt ($ctx.stageApproved == true) {
      analyst {
        reagent.return({
          stage: "finalization",
          status: "approved",
          artifact: $ctx.finalPacket,
          humanDecision: $ctx.lastDecision
        })
      }
    } else {
      analyst {
        $ctx.pendingChanges = $ctx.lastDecision.requestedChanges
      }
    }
  }
}

protocol FeatureDevelopmentReagent {
  participants:
    human [ts] initiator,
    analyst [ts],
    developer [ts],
    reviewer [ts]

  trigger on invoke with FeatureTask {
    resolve human = single
    resolve analyst = single
    resolve developer = single
    resolve reviewer = single
  }

  human {
    $ctx.task = $ctx.input
  }

  human invokes DesignStage($ctx.task) -> $ctx.designStage

  human invokes ImplementationStage({
    stage: "implementation",
    task: $ctx.task,
    previous: $ctx.designStage
  }) -> $ctx.implementationStage

  human invokes FinalizationStage({
    stage: "finalization",
    task: $ctx.task,
    previous: {
      design: $ctx.designStage,
      implementation: $ctx.implementationStage
    }
  }) -> $ctx.finalizationStage

  human {
    reagent.return({
      design: $ctx.designStage,
      implementation: $ctx.implementationStage,
      finalization: $ctx.finalizationStage
    })
  }
}

role HumanRole [ts] {
  plays FeatureDevelopmentReagent as human
  plays DesignStage as human
  plays ImplementationStage as human
  plays FinalizationStage as human

  init {
    $self.lastApprovedStage = null
  }

  on protocolCompleted(FeatureDevelopmentReagent) {
    $self.lastApprovedStage = "finalization"
  }
}

role AnalystRole [ts] {
  plays FeatureDevelopmentReagent as analyst
  plays DesignStage as analyst
  plays ImplementationStage as analyst
  plays FinalizationStage as analyst
}

role DeveloperRole [ts] {
  plays FeatureDevelopmentReagent as developer
  plays DesignStage as developer
  plays ImplementationStage as developer
  plays FinalizationStage as developer
}

role ReviewerRole [ts] {
  plays FeatureDevelopmentReagent as reviewer
  plays DesignStage as reviewer
  plays ImplementationStage as reviewer
  plays FinalizationStage as reviewer
}

agent HumanAgent runs HumanRole
agent AnalystAgent runs AnalystRole
agent DeveloperAgent runs DeveloperRole
agent ReviewerAgent runs ReviewerRole
