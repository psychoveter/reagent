// Autoscience — automated research process
//
// Four roles:
//   human      — the person: sets direction, approves key decisions
//   lead       — LLM research-lead: aggregates, summarizes, proposes next steps to human
//   consultant — LLM systematizer-critic: formalizes, critiques, writes documents
//   researcher — LLM experimenter: runs computational experiments
//
// Multiple consultants and researchers can participate (scatter).
// Lead is the single orchestrator LLM that interfaces with the human.
//
// All LLM roles connect via MCP Gate (mcp-gate-rfc.md).
// Messages are passed as-is — no boilerplate onSend/onReceive hooks.
// Each MCP agent receives the full message payload in ProtocolEvent
// and returns its response via reagent/respond.

// ─── Messages ───────────────────────────────────────────────────────

message Intuition {
  text: string
  domain: string
  relatedClaims: any
}

message FormalClaim {
  claimId: string
  statement: string
  conditions: any
  falsification: string
  status: string
  predictions: any
}

message CritiqueRequest {
  claims: any
  documentVersion: string
}

message CritiqueResult {
  weaknesses: any
  counterexamples: any
  suggestions: any
  severity: string
}

message Correction {
  originalClaimId: string
  correctedStatement: string
  reason: string
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
  pValue: number
  summary: string
}

message DocumentDraft {
  version: string
  content: string
  changelog: string
  claimStatuses: any
}

message DirectionUpdate {
  nextAction: string
  focus: string
  reasoning: string
  balanceCheck: string
}

message HumanDecision {
  approved: boolean
  action: string
  modifications: any
  comment: string
}

message ExpansionRequest {
  baseClaim: any
  direction: string
}

message ExpansionResult {
  derivedClaims: any
  connections: any
}

message ResearchState {
  liveClaims: any
  deadClaims: any
  pendingPredictions: any
  documentVersion: string
  theoryDataBalance: number
  cycleCount: number
}

message Summary {
  forHuman: string
  state: any
  recommendation: any
}

// ─── Main research cycle ────────────────────────────────────────────

protocol ResearchCycle {
  participants:
    human [ts] initiator,
    lead [ts],
    consultant [ts] dynamic many,
    researcher [ts] dynamic many

  trigger on invoke with Intuition {
    resolve human = single
    resolve lead = single
  }

  // Phase 1: Human provides initial intuition, lead initializes state
  human --> lead: Intuition

  lead {
    $ctx.liveClaims = []
    $ctx.deadClaims = []
    $ctx.documentVersion = "v0"
    $ctx.cycleCount = 0
    $ctx.theoryCycles = 0
    $ctx.dataCycles = 0
    $ctx.consultantIds = await $agent.get_consultant_ids()
    $ctx.researcherIds = await $agent.get_researcher_ids()
  }

  // Phase 2: Formalize the intuition via consultant
  lead --> consultant: Intuition

  consultant invokes Formalize({
    intuition: $ctx.msg,
    existingClaims: []
  }) -> $ctx.formalizedClaims

  consultant --> lead: FormalClaim = {
    onReceive {
      $ctx.liveClaims.push($ctx.msg)
    }
  }

  // Phase 3: Main research loop
  loop ($ctx.cycleCount < 20) {

    // Lead builds state summary and sends to human for decision
    lead {
      $ctx.state = {
        liveClaims: $ctx.liveClaims,
        deadClaims: $ctx.deadClaims,
        documentVersion: $ctx.documentVersion,
        theoryDataBalance: $ctx.theoryCycles - $ctx.dataCycles,
        cycleCount: $ctx.cycleCount
      }
      $ctx.summary = await $agent.build_summary($ctx.state)
    }

    lead --> human: Summary = {
      onSend {
        $ctx.msg.forHuman = $ctx.summary.forHuman
        $ctx.msg.state = $ctx.state
        $ctx.msg.recommendation = $ctx.summary.recommendation
      }
    }

    // Human decides next step
    human {
      $ctx.decision = await $agent.get_human_decision($ctx.msg)
    }

    human --> lead: HumanDecision

    lead {
      $ctx.nextAction = $ctx.msg.action
    }

    // Branch on action type
    alt ($ctx.nextAction == "critique") {

      // ── CRITICAL CYCLE ──
      lead {
        $ctx.theoryCycles = $ctx.theoryCycles + 1
      }

      scatter ($ctx.consultantIds as consultant) {
        lead --> consultant: CritiqueRequest = {
          onSend {
            $ctx.msg.claims = $ctx.liveClaims
            $ctx.msg.documentVersion = $ctx.documentVersion
          }
        }

        consultant invokes Critique({
          claims: $ctx.msg.claims,
          documentVersion: $ctx.msg.documentVersion
        }) -> $ctx.critiqueOutput

        consultant --> lead: CritiqueResult = {
          onReceive {
            $ctx.critiques = $ctx.critiques || []
            $ctx.critiques.push($ctx.msg)
          }
        }
      }

      // Lead aggregates critiques, presents to human
      lead {
        $ctx.critiqueSummary = await $agent.aggregate_critiques($ctx.critiques)
      }

      lead --> human: Summary = {
        onSend {
          $ctx.msg.forHuman = $ctx.critiqueSummary.text
          $ctx.msg.state = $ctx.critiques
          $ctx.msg.recommendation = $ctx.critiqueSummary.suggestedCorrections
        }
      }

      human {
        $ctx.corrections = await $agent.review_critiques_with_human($ctx.msg)
      }

      human --> lead: Correction

      // Fixate with corrections
      lead --> consultant: Correction

      consultant invokes Fixation({
        claims: $ctx.liveClaims,
        corrections: $ctx.msg,
        previousVersion: $ctx.documentVersion
      }) -> $ctx.newDocument

      consultant --> lead: DocumentDraft = {
        onReceive {
          $ctx.documentVersion = $ctx.msg.version
        }
      }

    } else ($ctx.nextAction == "experiment") {

      // ── EXPERIMENTAL CYCLE ──
      lead {
        $ctx.dataCycles = $ctx.dataCycles + 1
        $ctx.selectedPrediction = await $agent.select_prediction($ctx.liveClaims)
      }

      // Consultant designs experiment
      lead --> consultant: FormalClaim = {
        onSend {
          $ctx.msg = $ctx.selectedPrediction
        }
      }

      consultant {
        $ctx.experimentSpec = await $agent.design_experiment($ctx.msg)
      }

      consultant --> lead: ExperimentSpec

      // Lead presents spec to human for approval
      lead --> human: ExperimentSpec

      human {
        $ctx.specDecision = await $agent.approve_experiment($ctx.msg)
      }

      human --> lead: HumanDecision

      lead {
        $ctx.finalSpec = $ctx.msg.modifications || $ctx.experimentSpec
      }

      // Scatter experiment across researchers
      scatter ($ctx.researcherIds as researcher) {
        lead --> researcher: ExperimentSpec = {
          onSend {
            $ctx.msg = $ctx.finalSpec
          }
        }

        researcher invokes ExperimentRun({
          spec: $ctx.msg
        }) -> $ctx.result

        researcher --> lead: ExperimentResult = {
          onReceive {
            $ctx.experimentResults = $ctx.experimentResults || []
            $ctx.experimentResults.push($ctx.msg)
          }
        }
      }

      // Lead interprets results, presents to human
      lead {
        $ctx.interpretation = await $agent.interpret_results(
          $ctx.experimentResults, $ctx.liveClaims
        )
      }

      lead --> human: Summary = {
        onSend {
          $ctx.msg.forHuman = $ctx.interpretation.summary
          $ctx.msg.state = $ctx.experimentResults
          $ctx.msg.recommendation = $ctx.interpretation.claimUpdates
        }
      }

      human {
        $ctx.resultDecision = await $agent.confirm_interpretation($ctx.msg)
      }

      human --> lead: HumanDecision

      lead {
        $ctx.liveClaims = $ctx.msg.modifications
          ? $ctx.msg.modifications.liveClaims
          : $ctx.interpretation.liveClaims
        $ctx.deadClaims = $ctx.deadClaims.concat(
          $ctx.interpretation.killedClaims || []
        )
      }

      // Fixate
      lead --> consultant: ResearchState = {
        onSend {
          $ctx.msg = {
            liveClaims: $ctx.liveClaims,
            deadClaims: $ctx.deadClaims,
            documentVersion: $ctx.documentVersion
          }
        }
      }

      consultant invokes Fixation({
        claims: $ctx.msg.liveClaims,
        corrections: [],
        previousVersion: $ctx.msg.documentVersion,
        experimentResults: $ctx.experimentResults
      }) -> $ctx.updatedDocument

      consultant --> lead: DocumentDraft = {
        onReceive {
          $ctx.documentVersion = $ctx.msg.version
        }
      }

    } else ($ctx.nextAction == "expand") {

      // ── GENERATIVE CYCLE ──
      lead {
        $ctx.theoryCycles = $ctx.theoryCycles + 1
        $ctx.expansionSeed = await $agent.choose_expansion_direction($ctx.liveClaims)
      }

      scatter ($ctx.consultantIds as consultant) {
        lead --> consultant: ExpansionRequest = {
          onSend {
            $ctx.msg.baseClaim = $ctx.expansionSeed.claim
            $ctx.msg.direction = $ctx.expansionSeed.direction
          }
        }

        consultant {
          $ctx.expanded = await $agent.expand_claim(
            $ctx.msg.baseClaim,
            $ctx.msg.direction
          )
        }

        consultant --> lead: ExpansionResult = {
          onReceive {
            $ctx.expansions = $ctx.expansions || []
            $ctx.expansions.push($ctx.msg)
          }
        }
      }

      // Lead presents expansions to human
      lead {
        $ctx.expansionSummary = await $agent.summarize_expansions($ctx.expansions)
      }

      lead --> human: Summary = {
        onSend {
          $ctx.msg.forHuman = $ctx.expansionSummary.text
          $ctx.msg.state = $ctx.expansions
          $ctx.msg.recommendation = $ctx.expansionSummary.suggestedClaims
        }
      }

      human {
        $ctx.expansionDecision = await $agent.select_expansions($ctx.msg)
      }

      human --> lead: HumanDecision

      lead {
        $ctx.liveClaims = $ctx.liveClaims.concat(
          $ctx.msg.modifications || $ctx.expansionSummary.suggestedClaims
        )
      }

    } else {

      // ── STOP ──
      lead {
        reagent.break()
      }

    }

    lead {
      $ctx.cycleCount = $ctx.cycleCount + 1
    }
  }

  // Final fixation
  lead --> consultant: ResearchState = {
    onSend {
      $ctx.msg = {
        liveClaims: $ctx.liveClaims,
        deadClaims: $ctx.deadClaims,
        documentVersion: $ctx.documentVersion
      }
    }
  }

  consultant invokes Fixation({
    claims: $ctx.msg.liveClaims,
    corrections: [],
    previousVersion: $ctx.msg.documentVersion,
    isFinal: true
  }) -> $ctx.finalDocument

  consultant --> lead: DocumentDraft

  // Lead sends final report to human
  lead {
    $ctx.finalSummary = await $agent.build_final_report(
      $ctx.msg, $ctx.deadClaims, $ctx.cycleCount
    )
  }

  lead --> human: Summary = {
    onSend {
      $ctx.msg.forHuman = $ctx.finalSummary
      $ctx.msg.state = {
        document: $ctx.finalDocument,
        deadClaims: $ctx.deadClaims,
        cyclesCompleted: $ctx.cycleCount
      }
    }
    onReceive {
      $self.finalReport = $ctx.msg
    }
  }
}

// ─── Sub-protocol: Formalize ─────────────────────────────────────

protocol Formalize {
  participants:
    formalizer [ts] initiator
  trigger on invoke with FormalizeRequest {
    resolve formalizer = single
  }

  formalizer {
    $ctx.result = await $agent.formalize_intuition(
      $ctx.input.intuition,
      $ctx.input.existingClaims || []
    )
    reagent.return($ctx.result)
  }
}

// ─── Sub-protocol: Critique ──────────────────────────────────────

protocol Critique {
  participants:
    critic [ts] initiator
  trigger on invoke with CritiqueRequest {
    resolve critic = single
  }

  critic {
    $ctx.result = await $agent.critique_claims(
      $ctx.input.claims,
      $ctx.input.documentVersion
    )
    reagent.return($ctx.result)
  }
}

// ─── Sub-protocol: ExperimentRun ─────────────────────────────────

protocol ExperimentRun {
  participants:
    experimenter [ts] initiator
  trigger on invoke with ExperimentSpec {
    resolve experimenter = single
  }

  experimenter {
    $ctx.result = await $agent.run_experiment($ctx.input.spec)
    reagent.return($ctx.result)
  }
}

// ─── Sub-protocol: Fixation ──────────────────────────────────────

protocol Fixation {
  participants:
    writer [ts] initiator
  trigger on invoke with FixationRequest {
    resolve writer = single
  }

  writer {
    $ctx.result = await $agent.write_document(
      $ctx.input.claims,
      $ctx.input.corrections || [],
      $ctx.input.previousVersion,
      $ctx.input.experimentResults || [],
      $ctx.input.isFinal || false
    )
    reagent.return($ctx.result)
  }
}

// ─── Roles ──────────────────────────────────────────────────────

role HumanRole [ts] {
  plays ResearchCycle as human

  init {
    $self.finalReport = null
  }
}

role LeadRole [ts] {
  plays ResearchCycle as lead

  init {
    $self.cyclesManaged = 0
  }

  on protocolCompleted(ResearchCycle) {
    $self.cyclesManaged = $self.cyclesManaged + 1
  }
}

role ConsultantRole [ts] {
  plays ResearchCycle as consultant
  plays Formalize as formalizer
  plays Critique as critic
  plays Fixation as writer

  init {
    $self.documentsWritten = 0
    $self.critiquesGiven = 0
  }

  on protocolCompleted(Critique) {
    $self.critiquesGiven = $self.critiquesGiven + 1
  }

  on protocolCompleted(Fixation) {
    $self.documentsWritten = $self.documentsWritten + 1
  }
}

role ResearcherRole [ts] {
  plays ResearchCycle as researcher
  plays ExperimentRun as experimenter

  init {
    $self.experimentsRun = 0
  }

  on protocolCompleted(ExperimentRun) {
    $self.experimentsRun = $self.experimentsRun + 1
  }
}

// ─── Agents ─────────────────────────────────────────────────────
// In MCP Gate mode, LLM agents register dynamically.
// Human agent connects via MCP Gate with a human-in-the-loop $agent.
// Static definitions below are for simulation runs.

agent Human1 runs HumanRole
agent Lead1 runs LeadRole
agent Consultant1 runs ConsultantRole
agent Researcher1 runs ResearcherRole
