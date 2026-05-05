# Reagent Deep Dive Takes

## Core thesis

- Reagent is a **meta-language for building an agentic control plane**.
- The central problem of modern agent systems is not just capability, but **control, predictability, and governability**.
- Free-form ReAct-style agent loops give agents too much unconstrained freedom: they are flexible, but hard to inspect, constrain, verify, and trust.
- Reagent responds by making **interaction first-class**: communication, coordination, and control flow are explicit protocol constructs rather than hidden inside prompts or ad hoc code.

## Philosophy

- In Reagent, the protocol is not an implementation detail; it is the **primary coordination artifact**.
- Behavior lives at two levels:
  - protocol choreography in Reagent
  - local computation in host-language zones or external agent behaviors
- This lets systems keep agent intelligence while moving coordination into a surface that is readable, enforceable, and debuggable.
- The product thesis is: **agent systems need a control plane, not just more autonomous loops**.

## Architecture takes grounded in current docs

- `ReagentController` is the node-local execution core and the main runtime boundary.
- Reagent separates:
  - **message plane** for runtime delivery between RCs
  - **control plane** for deploy / trigger / inspect / stop operations
- The canonical control-plane model is **`AdminClient` + `StateStore` + per-node `NodeControlEndpoint`**.
- Reagent is distributed by design:
  - node-local runtime execution lives in RC
  - shared cluster truth lives in `StateStore`
  - multiple transport layers exist via `NodeLink` implementations such as in-memory, WebSocket, and NATS
- Runtime hosts can embed RC in different process shapes rather than forcing one universal host model.

## Agent integration model

- Reagent is intentionally open to heterogeneous agent runtimes and hosting styles.
- Current runtime paths include:
  - **managed agents** executing `.rg` zone code
  - **custom/external agents** through `CustomBehaviorFactory`
  - **gate-backed agents** through `GateBehaviorFactory`
  - **MCP-facing agents** through `mcp-gate`
- The important architectural point is not one agent SDK, but one **protocol-governed execution model** across different agent forms.

## Security and control

- Reagent's main security idea is **protocol-bounded interaction**.
- The engine enforces message ordering and protocol semantics; communication is mediated by the protocol state machine rather than by unconstrained agent-to-agent freedom.
- RC acts as a communication gate: agents do not simply emit arbitrary protocol-visible traffic whenever they want; the runtime advances only through legal protocol states.
- This is especially important in high-trust or high-risk environments where agent communication must be constrained, auditable, and operationally understandable.

## Verification and observability

- Reagent supports **verifiable protocols** through the `verify` pipeline that generates TLA+ artifacts and runs TLC when available.
- Reagent integrates with observability via **OpenTelemetry hooks**:
  - message-level spans
  - trace/event-level spans
- The value proposition is not only "agents can act", but also "their coordination can be inspected, traced, and reasoned about".

## Capability-aware interaction

- The current language already supports agent metadata such as tags, capabilities, and labels for resolve-time matching.
- The future `agent type` direction goes further:
  - different agent kinds declare what they can consume and produce
  - message formation becomes target-aware
  - heterogeneous participants such as MCP users, browser users, workers, and managed agents can share one protocol model
- This is the path toward richer capability-aware communication rather than one-size-fits-all JSON exchange.

## Strategic opportunity

- Reagent is aimed at reliable agent networks, not just local toy orchestrations.
- The strongest fit is in domains where communication discipline, auditability, and operational safety matter:
  - medicine
  - banking
  - finance
  - enterprise coordination
  - inter-organization workflows
- The long-term promise is to make **broad, distributed, protocol-governed agent networks** practical across organizational boundaries.

## Present vs future framing

- Current docs already support the core story:
  - protocol-first control
  - distributed RC-based architecture
  - heterogeneous runtime hosts
  - TLA+ verification path
  - OTel instrumentation
- Future docs extend that story through:
  - `agent type`
  - stronger scatter/gather semantics
  - distributed try/catch
  - richer resolve policies
  - broader runtime platform options
