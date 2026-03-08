// Autoscience (simple) — minimal research cycle
//
// Three participants, one of each:
//   human      — the person: intuitions, direction, approval
//   consultant — LLM: formalizes, critiques, writes documents
//   researcher — LLM: runs experiments, returns results
//
// No scatter, no lead aggregator. Direct 1-to-1 exchanges.
// Designed as the minimal viable autoscience protocol.

// ─── Messages ───────────────────────────────────────────────────────

message Intuition {
  text: string
  domain: string
}

message FormalClaim {
  claimId: string
  statement: string
  conditions: any
  falsification: string
  predictions: any
}

message CritiqueResult {
  weaknesses: any
  counterexamples: any
  suggestions: any
}

message HumanDecision {
  action: string
  comment: string
  modifications: any
}

message ExperimentSpec {
  experimentId: string
  question: string
  prediction: string
  procedure: string
  dataSource: string
  falsificationCriteria: string
}

message ExperimentResult {
  experimentId: string
  data: any
  verdict: string
  summary: string
}

message DocumentDraft {
  version: string
  content: string
  changelog: string
}

message ResearchState {
  liveClaims: any
  deadClaims: any
  documentVersion: string
  cycleCount: number
}

// ─── Main protocol ──────────────────────────────────────────────────

protocol SimpleResearch {
  participants:
    human [ts] initiator,
    consultant [ts],
    researcher [ts]

  trigger on invoke with Intuition {
    resolve human = single
    resolve consultant = single
    resolve researcher = single
  }

  // ── Init: human sends intuition, consultant formalizes ──

  human --> consultant: Intuition

  consultant {
    $ctx.formalClaim = await $agent.formalize($ctx.msg)
  }

  consultant --> human: FormalClaim

  human {
    $ctx.liveClaims = [$ctx.msg]
    $ctx.deadClaims = []
    $ctx.documentVersion = "v0"
    $ctx.cycleCount = 0
  }

  // ── Main loop ──

  loop ($ctx.cycleCount < 10) {

    // Present state, human decides next step
    human --> consultant: ResearchState = {
      onSend {
        $ctx.msg.liveClaims = $ctx.liveClaims
        $ctx.msg.deadClaims = $ctx.deadClaims
        $ctx.msg.documentVersion = $ctx.documentVersion
        $ctx.msg.cycleCount = $ctx.cycleCount
      }
    }

    consultant {
      $ctx.recommendation = await $agent.recommend_next_step($ctx.msg)
    }

    consultant --> human: HumanDecision = {
      onSend {
        $ctx.msg.action = $ctx.recommendation.action
        $ctx.msg.comment = $ctx.recommendation.reasoning
      }
    }

    // Human overrides or accepts
    human {
      $ctx.nextAction = await $agent.decide($ctx.msg, $ctx.liveClaims)
    }

    alt ($ctx.nextAction == "critique") {

      // ── CRITIQUE ──

      human --> consultant: ResearchState = {
        onSend {
          $ctx.msg.liveClaims = $ctx.liveClaims
          $ctx.msg.documentVersion = $ctx.documentVersion
        }
      }

      consultant {
        $ctx.critique = await $agent.critique($ctx.msg.liveClaims)
      }

      consultant --> human: CritiqueResult

      human {
        $ctx.corrections = await $agent.review_critique($ctx.msg, $ctx.liveClaims)
        $ctx.liveClaims = $ctx.corrections.updatedClaims
      }

      // Fixate
      human --> consultant: ResearchState = {
        onSend {
          $ctx.msg.liveClaims = $ctx.liveClaims
          $ctx.msg.deadClaims = $ctx.deadClaims
          $ctx.msg.documentVersion = $ctx.documentVersion
        }
      }

      consultant {
        $ctx.doc = await $agent.write_document(
          $ctx.msg.liveClaims, $ctx.msg.documentVersion
        )
      }

      consultant --> human: DocumentDraft = {
        onReceive {
          $ctx.documentVersion = $ctx.msg.version
        }
      }

    } else ($ctx.nextAction == "experiment") {

      // ── EXPERIMENT ──

      // Consultant designs experiment spec from a claim
      human --> consultant: FormalClaim = {
        onSend {
          $ctx.msg = $ctx.liveClaims[$ctx.liveClaims.length - 1]
        }
      }

      consultant {
        $ctx.spec = await $agent.design_experiment($ctx.msg)
      }

      consultant --> human: ExperimentSpec

      // Human approves
      human {
        $ctx.approvedSpec = await $agent.approve_spec($ctx.msg)
      }

      // Researcher runs it
      human --> researcher: ExperimentSpec = {
        onSend {
          $ctx.msg = $ctx.approvedSpec
        }
      }

      researcher {
        $ctx.result = await $agent.run_experiment($ctx.msg)
      }

      researcher --> human: ExperimentResult

      // Human interprets
      human {
        $ctx.interpretation = await $agent.interpret($ctx.msg, $ctx.liveClaims)
        $ctx.liveClaims = $ctx.interpretation.liveClaims
        $ctx.deadClaims = $ctx.deadClaims.concat($ctx.interpretation.killed || [])
      }

      // Fixate
      human --> consultant: ResearchState = {
        onSend {
          $ctx.msg.liveClaims = $ctx.liveClaims
          $ctx.msg.deadClaims = $ctx.deadClaims
          $ctx.msg.documentVersion = $ctx.documentVersion
        }
      }

      consultant {
        $ctx.doc = await $agent.write_document(
          $ctx.msg.liveClaims, $ctx.msg.documentVersion
        )
      }

      consultant --> human: DocumentDraft = {
        onReceive {
          $ctx.documentVersion = $ctx.msg.version
        }
      }

    } else ($ctx.nextAction == "expand") {

      // ── EXPANSION ──

      human --> consultant: FormalClaim = {
        onSend {
          $ctx.msg = $ctx.liveClaims[$ctx.liveClaims.length - 1]
        }
      }

      consultant {
        $ctx.expanded = await $agent.expand($ctx.msg)
      }

      consultant --> human: FormalClaim = {
        onSend {
          $ctx.msg = $ctx.expanded
        }
      }

      human {
        $ctx.accepted = await $agent.evaluate_expansion($ctx.msg)
        if ($ctx.accepted) { $ctx.liveClaims.push($ctx.msg) }
      }

    } else {

      // ── STOP ──
      human {
        reagent.break()
      }
    }

    human {
      $ctx.cycleCount = $ctx.cycleCount + 1
    }
  }

  // Final document
  human --> consultant: ResearchState = {
    onSend {
      $ctx.msg.liveClaims = $ctx.liveClaims
      $ctx.msg.deadClaims = $ctx.deadClaims
      $ctx.msg.documentVersion = $ctx.documentVersion
    }
  }

  consultant {
    $ctx.finalDoc = await $agent.write_document(
      $ctx.msg.liveClaims, $ctx.msg.documentVersion
    )
  }

  consultant --> human: DocumentDraft = {
    onReceive {
      $self.finalDocument = $ctx.msg
      $self.cyclesCompleted = $ctx.cycleCount
    }
  }
}

// ─── Roles ──────────────────────────────────────────────────────────

role SimpleHumanRole [ts] {
  plays SimpleResearch as human

  init {
    $self.finalDocument = null
    $self.cyclesCompleted = 0
  }
}

role SimpleConsultantRole [ts] {
  plays SimpleResearch as consultant
}

role SimpleResearcherRole [ts] {
  plays SimpleResearch as researcher
}

// ─── Agents ─────────────────────────────────────────────────────────

agent SimpleHuman runs SimpleHumanRole
agent SimpleConsultant runs SimpleConsultantRole
agent SimpleResearcher runs SimpleResearcherRole
