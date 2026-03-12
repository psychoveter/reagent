# End-to-End Use Cases

Five reference use cases covering the breadth of the Reagent language and runtime stack. Each is a self-contained story: domain problem, protocol design, agent integration mode, and deployment shape.

The cases are chosen to be maximally distant from each other across three axes:
- **deployment topology** (single-process ↔ multi-node cluster)
- **agent integration mode** (managed ↔ custom ↔ message gate ↔ MCP gate)
- **activation model** (invoke ↔ cron ↔ event)

---

## 1. Sealed-Bid Auction Simulation

**Domain**: market microstructure / game theory.

**Problem**: a researcher runs hundreds of sealed-bid auctions with different bidding strategies in a tight edit-run loop. All agents live in one process; the only goal is fast iteration — change a strategy, re-run, compare.

### Protocol

```rg
message AuctionStart { itemName: string, reservePrice: number }
message Bid { amount: number }
message BidResult { won: boolean, finalPrice: number }

protocol Auction {
  participants:
    seller [py] initiator,
    buyer [py] dynamic many

  trigger on invoke with AuctionStart {
    resolve seller = single
  }

  seller {
    $ctx.buyerIds = await $agent.get_buyer_ids()
    $ctx.bids = []
  }

  scatter ($ctx.buyerIds as buyer) {
    seller --> buyer: AuctionStart = {
      onSend    { $ctx.msg.itemName = $ctx.input.itemName }
      onReceive { $self.currentItem = $ctx.msg.itemName }
    }

    buyer {
      $ctx.bidAmount = await $agent.decide_bid($self.currentItem, $ctx.msg.reservePrice)
    }

    buyer --> seller: Bid = {
      onSend    { $ctx.msg.amount = $ctx.bidAmount }
      onReceive { $ctx.bids.append({"idx": $ctx._scatterIdx, "amount": $ctx.msg.amount}) }
    }
  }

  seller {
    $ctx.result = await $agent.evaluate_bids($ctx.bids, $ctx.input.reservePrice)
  }

  scatter ($ctx.buyerIds as buyer) {
    seller --> buyer: BidResult = {
      onSend    { $ctx.msg.won = ($ctx._scatterIdx == $ctx.result["winnerIdx"]) }
      onReceive { $self.lastResult = "won" if $ctx.msg.won else "lost" }
    }
  }
}

role SellerRole [py] { plays Auction as seller }
role BuyerRole  [py] { plays Auction as buyer }

agent Auctioneer runs SellerRole
agent Buyer1 runs BuyerRole
agent Buyer2 runs BuyerRole
agent Buyer3 runs BuyerRole
```

### Agents and runtime

| Agent | `$agent` module | Integration mode |
|---|---|---|
| Auctioneer | `seller_io.py` — item catalog, result logging | Managed (`InprocAgentNode`) |
| Buyer1..N | `buyer_strategy.py` — pluggable bidding function | Managed (`InprocAgentNode`) |

| Aspect | Choice |
|---|---|
| Runtime | Python RC, single process |
| Cluster | none — in-process loopback |
| Launch | `python run.py --item "Rare Painting" --reserve 200` |

### What it exercises

- `scatter` for fan-out to N buyers and result broadcast
- `$agent` native modules for pluggable I/O
- `$self` for persistent state across auction rounds
- `[py]` zones with Python-native syntax
- Single-process managed execution — zero infrastructure

### Why Reagent fits

This shows Reagent as a precise local protocol runtime for structured multi-agent simulation — not just a distributed LLM orchestration layer. The protocol is the experiment specification; swapping strategy is editing `module.py`, not rewiring infrastructure.

---

## 2. Distributed LLM Research Swarm

**Domain**: automated research / LLM-assisted knowledge work.

**Problem**: a human researcher (in Cursor IDE) formulates a hypothesis. LLM agents — a systematizer and multiple experimenters — decompose, execute, and report back. All agents run on separate machines: the human in their IDE, the LLM agents in Docker containers. The system supports iterative research cycles, parallel experiment execution, and human approval at key checkpoints.

### Protocol

The use case is a family of protocols. The top-level `ResearchCycle` composes child protocols via `invokes`:

```rg
message Hypothesis { topic: string, question: string }
message ResearchPlan { steps: any[], criteria: string }
message ExperimentRequest { step: any, constraints: any }
message ExperimentResult { data: any, analysis: string }

protocol ResearchCycle {
  participants:
    theorist [ts] initiator,
    systematizer [ts],
    experimenter [ts] dynamic many

  trigger on invoke with Hypothesis {
    resolve theorist = single
    resolve systematizer = single
    resolve experimenter = all | filter(hasTag("researcher"))
  }

  theorist --> systematizer: Hypothesis = {
    onSend    { $ctx.msg.topic = $ctx.input.topic; $ctx.msg.question = $ctx.input.question }
    onReceive { $ctx.hypothesis = $ctx.msg }
  }

  systematizer {
    // LLM decomposes hypothesis into falsifiable experiment steps.
  }

  systematizer --> theorist: ResearchPlan = {
    onSend    { $ctx.msg.steps = $ctx.plan.steps; $ctx.msg.criteria = $ctx.plan.criteria }
    onReceive { $ctx.plan = $ctx.msg }
  }

  theorist {
    // Human reviews plan in Cursor, approves or edits.
  }

  scatter ($ctx.plan.steps as experimenter) {
    theorist --> experimenter: ExperimentRequest = {
      onSend    { $ctx.msg.step = $ctx._scatterItem }
      onReceive { $ctx.task = $ctx.msg.step }
    }

    experimenter {
      // LLM agent runs the experiment step autonomously.
    }

    experimenter --> theorist: ExperimentResult = {
      onSend    { $ctx.msg.data = $ctx.result.data; $ctx.msg.analysis = $ctx.result.analysis }
      onReceive { $ctx.results.push($ctx.msg) }
    }
  }

  theorist {
    // Human reviews all results and decides whether to iterate or conclude.
  }
}
```

### Agents and runtime

| Agent | Host | Integration mode |
|---|---|---|
| Theorist (human) | Cursor IDE, local Mac | MCP Gate — Cursor as MCP client |
| Systematizer (LLM) | Docker container, remote | MCP Gate — Claude Agent SDK |
| Experimenter×N (LLM) | Docker containers, remote | MCP Gate — Claude Agent SDK |

| Aspect | Choice |
|---|---|
| Runtime | TypeScript RC per node, `mcp-gate` subprocess per agent |
| Cluster | etcd (discovery + leader), NATS (inter-node messaging) |
| Infrastructure | `docker compose` — NATS, etcd, etcd-viewer |
| Deploy | `AdminClient` → compile → deploy → trigger from Cursor |

### What it exercises

- Multi-node distributed cluster with etcd and NATS
- MCP Gate pull model for LLM agents
- Human-in-the-loop via Cursor IDE as MCP client
- `scatter` across remote nodes
- `resolve` pipelines with `filter(hasTag(...))`
- Docker isolation for autonomous LLM workers
- Protocol composition via `invokes` (sub-protocols for Formalize, Critique, etc.)
- `$self` persistence on long-lived agents

### Why Reagent fits

This is the canonical "many distributed cognitive workers" case. Reagent makes the coordination explicit: who may talk to whom, where human approval sits, how scatter/aggregation flows. Role boundaries survive even when agents are LLM sessions that could otherwise do anything.

---

## 3. IoT Sensor Pipeline with Cron and Event Triggers

**Domain**: industrial IoT / edge monitoring.

**Problem**: a factory has temperature sensors and a central monitor. Every 5 minutes the monitor polls all sensors. If any reading crosses a threshold, a reactive protocol launches an investigation — a diagnostics agent analyzes the pattern and recommends action.

### Protocol

Two cooperating protocols in one project:

```rg
message SensorReading { sensorId: string, temperature: number, ts: number }
message AnomalyAlert { sensorId: string, value: number, threshold: number }
message DiagnosisRequest { alert: any, history: any[] }
message DiagnosisResult { rootCause: string, action: string }

protocol ScheduledPoll {
  participants:
    monitor [py] static single initiator,
    sensor [py] dynamic many

  trigger on cron "*/5 * * * *" {
    resolve monitor = single
    resolve sensor = all | filter(hasTag("temperature"))
  }

  monitor {
    $ctx.sensorIds = await $agent.get_registered_sensors()
    $ctx.readings = []
  }

  scatter ($ctx.sensorIds as sensor) {
    monitor --> sensor: SensorReading = {
      onSend { $ctx.msg.sensorId = $ctx._scatterItem }
    }

    sensor {
      $ctx.reading = await $agent.read_temperature()
    }

    sensor --> monitor: SensorReading = {
      onSend {
        $ctx.msg.sensorId = $self.sensorId
        $ctx.msg.temperature = $ctx.reading
        $ctx.msg.ts = $agent.now()
      }
      onReceive { $ctx.readings.append($ctx.msg) }
    }
  }

  monitor {
    $self.history.append($ctx.readings)
    anomalies = [r for r in $ctx.readings if r["temperature"] > $self.threshold]
    for a in anomalies:
      reagent.emit("anomaly.detected", a)
  }
}

protocol AnomalyInvestigation {
  participants:
    monitor [py] static single initiator,
    diagnostics [py]

  trigger on event "anomaly.detected" with AnomalyAlert {
    resolve monitor = single
    resolve diagnostics = single
  }

  monitor --> diagnostics: DiagnosisRequest = {
    onSend {
      $ctx.msg.alert = $ctx.input
      $ctx.msg.history = $self.history[-10:]
    }
    onReceive {
      $ctx.alert = $ctx.msg.alert
      $ctx.msg_history = $ctx.msg.history
    }
  }

  diagnostics {
    $ctx.diagnosis = await $agent.analyze($ctx.alert, $ctx.msg_history)
  }

  diagnostics --> monitor: DiagnosisResult = {
    onSend {
      $ctx.msg.rootCause = $ctx.diagnosis["rootCause"]
      $ctx.msg.action = $ctx.diagnosis["action"]
    }
    onReceive {
      await $agent.execute_action($ctx.msg.action)
      $self.lastDiagnosis = $ctx.msg
    }
  }
}
```

### Agents and runtime

| Agent | `$agent` module | Integration mode |
|---|---|---|
| CentralMonitor | `monitor_io.py` — sensor registry, action executor | Managed |
| SensorN | `sensor_hw.py` — hardware I/O | Managed |
| DiagnosticsEngine | `diag_ml.py` — ML anomaly classifier | Managed |

| Aspect | Choice |
|---|---|
| Runtime | Python RC, single process on edge gateway |
| Cluster | single node, `InMemoryStateStore` |
| Triggers | `cron` for scheduled polling, `event` for reactive investigation |

### What it exercises

- `trigger on cron` — time-based protocol activation
- `trigger on event` — reactive protocol chaining via `reagent.emit()`
- `resolve` pipelines with `all | filter(hasTag(...))` and `single`
- Two protocols cooperating: cron → emit → event trigger
- `$self.history` for cross-instance persistent state
- `scatter` for dynamic fan-out to sensor fleet

### Why Reagent fits

This is not an LLM or simulation case — it shows Reagent as an operational protocol runtime for periodic + reactive workflows. The cron→emit→event chain is a first-class language feature, not ad-hoc glue.

---

## 4. Cross-Language Microservice Orchestration

**Domain**: fintech / payment processing.

**Problem**: a payment gateway coordinates a TypeScript order service, a Python fraud engine, and a Kotlin notification service. The protocol retries transient failures, compensates on fatal errors, and uses parallel processing for independent steps.

### Protocol

```rg
message PaymentRequest { orderId: string, amount: number, currency: string }
message FraudCheck { orderId: string, riskScore: number, approved: boolean }
message ChargeResult { success: boolean, transactionId: string }
message Notification { recipientId: string, channel: string, body: string }

protocol ProcessPayment {
  participants:
    gateway [ts] static single initiator,
    fraud [py],
    ledger [ts],
    notifier [kt]

  trigger on invoke with PaymentRequest {
    resolve gateway = single
    resolve fraud = single
    resolve ledger = single
    resolve notifier = single
  }

  // Step 1: fraud check
  gateway --> fraud: PaymentRequest = {
    onSend {
      $ctx.msg.orderId = $ctx.input.orderId
      $ctx.msg.amount = $ctx.input.amount
      $ctx.msg.currency = $ctx.input.currency
    }
    onReceive { $ctx.order = $ctx.msg }
  }

  fraud {
    $ctx.risk = await $agent.score_transaction($ctx.order)
  }

  fraud --> gateway: FraudCheck = {
    onSend {
      $ctx.msg.orderId = $ctx.order["orderId"]
      $ctx.msg.riskScore = $ctx.risk["score"]
      $ctx.msg.approved = $ctx.risk["score"] < 0.7
    }
    onReceive { $ctx.fraudResult = $ctx.msg }
  }

  alt ($ctx.fraudResult.approved == true) {
    // Step 2: charge + notify in parallel
    par {
      gateway --> ledger: PaymentRequest = {
        onSend    { $ctx.msg.orderId = $ctx.input.orderId; $ctx.msg.amount = $ctx.input.amount }
        onReceive { $ctx.chargeReq = $ctx.msg }
      }

      ledger {
        $ctx.txResult = await $agent.charge($ctx.chargeReq)
      }

      ledger --> gateway: ChargeResult = {
        onSend    { $ctx.msg.success = $ctx.txResult.success; $ctx.msg.transactionId = $ctx.txResult.txId }
        onReceive { $ctx.chargeResult = $ctx.msg }
      }
    } and {
      gateway --> notifier: Notification = {
        onSend {
          $ctx.msg.recipientId = $ctx.input.orderId
          $ctx.msg.channel = "email"
          $ctx.msg.body = "Processing payment for order " + $ctx.input.orderId
        }
      }
    }

    gateway {
      $self.processedOrders = ($self.processedOrders ?? 0) + 1
      reagent.return({ transactionId: $ctx.chargeResult.transactionId, status: "completed" })
    }
  } else {
    // Rejected: notify and return failure
    gateway --> notifier: Notification = {
      onSend {
        $ctx.msg.recipientId = $ctx.input.orderId
        $ctx.msg.channel = "email"
        $ctx.msg.body = "Payment rejected: risk score " + $ctx.fraudResult.riskScore
      }
    }

    gateway {
      reagent.return({ transactionId: null, status: "rejected", reason: "fraud_check_failed" })
    }
  }
}
```

> **Note on `try/catch`**: an earlier draft of this use case used `try/catch` for error handling. In a distributed protocol, a `throw` can originate on any role (fraud engine, ledger, notifier), but the `catch` block must specify concrete message steps — which requires knowing the faulting role at protocol-design time. The semantics of distributed `try/catch` — error propagation from arbitrary roles, fault originator binding, in-flight message cleanup inside `par` — are an open design problem tracked in the backlog (L1). This version uses `alt` branching instead, which has well-defined semantics today.

### Agents and runtime

| Agent | Language | Host | Integration mode |
|---|---|---|---|
| PaymentGateway | `[ts]` | TS node, in-process | Managed (`NativeAgentNode`) |
| FraudEngine | `[py]` | Python subprocess | Managed (`PythonAgentNode`) |
| Ledger | `[ts]` | TS node, in-process | Managed (`NativeAgentNode`) |
| NotificationSvc | `[kt]` | External process | Message Gate (`HttpGateTransport`) |

| Aspect | Choice |
|---|---|
| Integration modes | Managed (gateway, ledger), Python subprocess (fraud), Message Gate HTTP (notifier) |
| Runtime | TypeScript RC as main orchestrator |
| Transport | Loopback for TS, IPC for Python, HTTP for Kotlin |
| Cluster | single node — no etcd |

### What it exercises

- Cross-language agents: `[ts]`, `[py]`, `[kt]` in one protocol
- `par` for parallel independent steps (charge + notify)
- `alt` with expression guards for conditional branching
- `reagent.return()` for protocol result to invoker
- `PythonAgentNode` for subprocess-based Python agents
- `MessageGateNode` with `HttpGateTransport` for external Kotlin service
- Three integration modes in a single protocol

### Why Reagent fits

This is the heterogeneous-runtime showcase. The protocol stays readable regardless of how many languages and transports are involved. Each participant's host language and integration mode is declared once; the choreography is the same whether fraud runs in-process or across the network.

---

## 5. Scheduled Risk Review with Approval and Child Protocols

**Domain**: financial operations / compliance.

**Problem**: every weekday morning the system collects positions and exposures, scores them for risk, prepares a review package, and asks a human approver for sign-off. On rejection the system spawns remediation agents. The workflow uses persistent state to track reviewer decisions across days.

### Protocol

```rg
message RiskInput { date: string, scope: string }
message PositionData { positions: any[], asOf: string }
message RiskScore { violations: any[], overallRisk: number }
message ReviewPackage { summary: string, score: any, data: any }
message ApprovalDecision { approved: boolean, comments: string }
message RemediationTask { violation: any, assignee: string }
message RemediationResult { resolved: boolean, notes: string }

protocol CollectPositions {
  participants:
    collector [ts] initiator,
    source [ts] dynamic many

  trigger on invoke with RiskInput

  scatter ($ctx.input.sourceIds as source) {
    collector --> source: RiskInput = {
      onSend    { $ctx.msg.date = $ctx.input.date; $ctx.msg.scope = $ctx.input.scope }
      onReceive { $ctx.req = $ctx.msg }
    }

    source {
      $ctx.data = await $agent.fetchPositions($ctx.req.date, $ctx.req.scope)
    }

    source --> collector: PositionData = {
      onSend    { $ctx.msg.positions = $ctx.data.positions; $ctx.msg.asOf = $ctx.data.asOf }
      onReceive { $ctx.allPositions.push($ctx.msg) }
    }
  }

  collector {
    reagent.return($ctx.allPositions)
  }
}

protocol DailyRiskReview {
  participants:
    reviewer [ts] static single initiator,
    scorer [ts],
    approver [ts]

  trigger on cron "0 9 * * MON-FRI" {
    resolve reviewer = single
    resolve scorer = single
    resolve approver = all | filter(hasTag("risk-approver")) | first
  }

  reviewer {
    $ctx.today = new Date().toISOString().slice(0, 10)
    $self.reviewCount = ($self.reviewCount ?? 0) + 1
  }

  reviewer invokes CollectPositions({ date: $ctx.today, scope: "all", sourceIds: $self.sourceIds }) -> $ctx.positions

  reviewer --> scorer: PositionData = {
    onSend    { $ctx.msg.positions = $ctx.positions; $ctx.msg.asOf = $ctx.today }
    onReceive { $ctx.data = $ctx.msg }
  }

  scorer {
    $ctx.score = await $agent.computeRisk($ctx.data)
  }

  scorer --> reviewer: RiskScore = {
    onSend    { $ctx.msg.violations = $ctx.score.violations; $ctx.msg.overallRisk = $ctx.score.risk }
    onReceive { $ctx.riskScore = $ctx.msg }
  }

  reviewer --> approver: ReviewPackage = {
    onSend {
      $ctx.msg.summary = "Daily risk review for " + $ctx.today
      $ctx.msg.score = $ctx.riskScore
      $ctx.msg.data = $ctx.positions
    }
    onReceive { $ctx.package = $ctx.msg }
  }

  approver {
    // Human or MCP-backed reviewer examines the package and decides.
  }

  approver --> reviewer: ApprovalDecision = {
    onSend    { $ctx.msg.approved = $ctx.decision.approved; $ctx.msg.comments = $ctx.decision.comments }
    onReceive { $ctx.approval = $ctx.msg }
  }

  alt ($ctx.approval.approved == true) {
    reviewer {
      $self.lastApproved = $ctx.today
      reagent.emit("risk.approved", { date: $ctx.today })
    }
  } else {
    // Spawn remediation for each violation
    scatter ($ctx.riskScore.violations as remediator) {
      reviewer spawns RemediatorRole({ violation: $ctx._scatterItem }) as remediator

      reviewer --> remediator: RemediationTask = {
        onSend    { $ctx.msg.violation = $ctx._scatterItem; $ctx.msg.assignee = $ctx.approval.comments }
        onReceive { $ctx.task = $ctx.msg }
      }

      remediator {
        $ctx.result = await $agent.remediate($ctx.task)
      }

      remediator --> reviewer: RemediationResult = {
        onSend    { $ctx.msg.resolved = $ctx.result.resolved; $ctx.msg.notes = $ctx.result.notes }
        onReceive { $ctx.remediations.push($ctx.msg) }
      }
    }

    reviewer {
      $self.lastRejected = $ctx.today
      reagent.emit("risk.remediated", { date: $ctx.today, count: $ctx.remediations.length })
    }
  }
}

role ReviewerRole [ts] {
  plays DailyRiskReview as reviewer
  plays CollectPositions as collector

  init {
    $self.reviewCount = 0
    $self.sourceIds = ["equities", "fixed-income", "derivatives"]
  }

  on protocolCompleted(DailyRiskReview) {
    reagent.emit("review.cycle.done", { count: $self.reviewCount })
  }
}

role RemediatorRole [ts] {
  plays DailyRiskReview as remediator

  init { $self.resolved = 0 }
}
```

### Agents and runtime

| Agent | Integration mode | Notes |
|---|---|---|
| RiskReviewer | Custom (`CustomAgentNode`) | Stateful, multi-protocol role |
| RiskScorer | Managed (`NativeAgentNode`) | `$agent` wraps risk model |
| Approver | MCP Gate | Human or LLM via `mcp-gate` |
| Remediator (dynamic) | Managed (spawned) | Created per violation |

| Aspect | Choice |
|---|---|
| Runtime | TypeScript RC |
| Cluster | etcd for discovery + cron leader election |
| Triggers | `cron` for daily schedule |
| Composition | `reviewer invokes CollectPositions(...)` — child protocol call |

### What it exercises

- `trigger on cron` with `resolve` pipelines (`all | filter | first`)
- `invokes` — synchronous child protocol composition with `reagent.return()`
- `spawns` — dynamic agent creation for per-violation remediation
- `alt` for approval/rejection branching
- `role` with `init`, `on protocolCompleted`, multi-protocol `plays`
- `reagent.emit()` for downstream event chains
- `$self` persistence across daily review cycles
- Mixed integration: Custom Agent + Managed + MCP Gate + spawned agents
- `scatter` for remediation fan-out

### Why Reagent fits

This is the "enterprise workflow" case. It shows Reagent handling scheduled, approval-gated, multi-step business processes — not just real-time agent swarms. The protocol is auditable: every step, approval, and remediation is part of the choreography and appears in the trace.

---

## Coverage Matrix

| Feature | UC1 Auction | UC2 Research | UC3 IoT | UC4 Payment | UC5 Risk Review |
|---|:---:|:---:|:---:|:---:|:---:|
| **Language constructs** | | | | | |
| `scatter` | x | x | x | | x |
| `par` | | | | x | |
| `loop` | | | | | |
| `alt` (expression) | | | | x | x |
| `invokes` (child protocol) | | | | | x |
| `spawns` | | | | | x |
| `reagent.return()` | | | | x | x |
| `reagent.emit()` | | | x | | x |
| `reagent.break()` | | | | | |
| `trigger on invoke` | x | x | | x | |
| `trigger on cron` | | | x | | x |
| `trigger on event` | | | x | | |
| `resolve` pipelines | | x | x | | x |
| `message` type defs | x | x | x | x | x |
| `role` + `init` + `on` | | | | | x |
| `$agent` native module | x | | x | | |
| `$self` persistence | x | x | x | x | x |
| **Runtime modes** | | | | | |
| Managed (`NativeAgentNode`) | x | | x | x | x |
| Custom (`CustomAgentNode`) | | | | | x |
| Message Gate | | | | x | |
| MCP Gate | | x | | | x |
| **Deployment** | | | | | |
| Single-process (Python RC) | x | | x | | |
| Single-process (TS RC) | | | | x | |
| Multi-node cluster | | x | | | x |
| Docker + etcd + NATS | | x | | | |
| Cross-language agents | | | | x | |
| Human-in-the-loop | | x | | | x |
