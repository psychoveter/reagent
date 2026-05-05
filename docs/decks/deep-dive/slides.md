---
theme: seriph
title: Reagent Deep Dive
class: text-center
transition: slide-left
exportFilename: deep-dive
drawings:
  persist: false
---

# Reagent

## Meta-language for an agentic control plane

<div class="pt-6 text-xl opacity-80">
Philosophy, architecture, and capability model for reliable agent systems
</div>

<div class="abs-br m-6 flex gap-2">
  <span class="text-sm opacity-50">Deep Dive · 2026</span>
</div>

---
transition: slide-left
---

# The central problem

Modern agent systems have no shortage of intelligence.

They have a shortage of:

- control
- predictability
- communication discipline
- auditability
- operational trust

<div class="mt-8 p-5 rounded-xl bg-red-500/10 border border-red-500/20 text-center">
  The hardest part of agent systems is not making agents <strong>capable</strong>.
  It is making their behavior <strong>governable</strong>.
</div>

---
transition: slide-left
---

# Why free-form agent loops are not enough

ReAct-style loops are powerful because they are flexible.

They are also risky because they hide coordination inside:

- prompts
- tool-call policies
- local heuristics
- implicit message contracts
- runtime side effects

| Free-form loop | Protocol-governed system |
|---|---|
| hidden coordination | explicit interaction model |
| ad hoc communication | typed message steps |
| hard to constrain | runtime-enforced flow |
| hard to verify | formal protocol surface |
| hard to audit | traceable control path |

---
transition: slide-left
---

# Reagent's thesis

<div class="text-2xl mt-4">
Interaction is a <strong class="text-blue-300">first-class citizen</strong>.
</div>

<div class="grid grid-cols-2 gap-6 mt-8">
  <div class="p-5 rounded-xl bg-blue-500/10 border border-blue-500/20">
    <div class="font-bold text-blue-300">What Reagent makes explicit</div>
    <div class="text-sm mt-3 opacity-75">participants, messages, triggers, control flow, invoke/spawn/scatter, resolution, protocol boundaries</div>
  </div>
  <div class="p-5 rounded-xl bg-green-500/10 border border-green-500/20">
    <div class="font-bold text-green-300">What stays local to the agent</div>
    <div class="text-sm mt-3 opacity-75">reasoning, tool use, domain logic, local state transitions, host-language execution, external integrations</div>
  </div>
</div>

<div class="mt-6 p-4 rounded-lg bg-gray-800/50 text-center">
  Reagent does not try to remove intelligence from agents.
  It moves <strong>coordination</strong> into a surface that can be read, enforced, traced, and verified.
</div>

---
transition: slide-left
---

# What Reagent is

From the current docs:

- Reagent is a **protocol language**
- actual computation happens in host-language zones
- the runtime injects execution bindings like `$ctx`, `$self`, `reagent`, and optional `$agent`
- protocol-level constructs govern communication, control flow, and orchestration

```mermaid {scale: 0.72}
flowchart LR
    P["Reagent protocol<br/>choreography"] --> Z["Host-language zones<br/>local computation"]
    Z --> R["Runtime execution<br/>RC + RoleRun + RoleEngine"]
    style P fill:#1e3a5f,stroke:#60a5fa,color:#fff
    style Z fill:#1f4d3a,stroke:#34d399,color:#fff
    style R fill:#4a3419,stroke:#fb923c,color:#fff
```

---
transition: slide-left
---

# Reagent as control plane

The key abstraction is not "agent framework".

It is **agentic control plane**:

- protocols define allowed interaction
- RC executes the protocol state machine
- tools and operators use a separate control surface to deploy, trigger, inspect, and stop

| Plane | Responsibility |
|---|---|
| Protocol plane | who can say what, when, and in what order |
| Runtime plane | execute the state machine on live agents |
| Control plane | manage nodes, deployments, and cluster operations |

---
transition: slide-left
---

# Architecture overview

```mermaid {scale: 0.64}
flowchart TD
    LANG["Language<br/>messages, roles, triggers, choreography"] --> COMP["Compiler + IR<br/>fingerprints, lockfile, verify"]
    COMP --> RC["ReagentController<br/>node-local execution core"]
    RC --> STORE["StateStore<br/>shared cluster truth"]
    STORE --> ADMIN["AdminClient<br/>canonical tool-facing control API"]
    RC --> LINK["NodeLink<br/>message plane transports"]
    ADMIN --> NODE["NodeControlEndpoint<br/>per-node imperative control"]
    RC --> HOSTS["Runtime hosts<br/>managed, custom, gate, MCP"]
    RC --> OBS["OTel hooks<br/>message spans + trace events"]
    style LANG fill:#1e3a5f,stroke:#60a5fa,color:#fff
    style RC fill:#1f4d3a,stroke:#34d399,color:#fff
    style ADMIN fill:#4a3419,stroke:#fb923c,color:#fff
    style HOSTS fill:#3f1f5f,stroke:#c084fc,color:#fff
```

---
transition: slide-left
---

# RC is the communication gate

Reagent's security idea is not "the agent promises to behave".

It is:

- the runtime advances through legal protocol states
- the engine enforces message ordering and protocol semantics
- protocol-visible communication is mediated by the state machine

<div class="mt-8 p-5 rounded-xl bg-orange-500/10 border border-orange-500/20">
  <div class="text-lg font-bold text-orange-300">Protocol-bounded interaction</div>
  <div class="text-sm mt-3 opacity-80">
    Agents do not simply invent arbitrary protocol-visible traffic.
    RC acts as the gate that constrains communication to what the protocol allows.
  </div>
</div>

<div class="mt-6 text-sm opacity-70">
This is why Reagent is relevant in reliability-sensitive environments.
</div>

---
transition: slide-left
---

# Open to heterogeneous agents

The current runtime model already supports multiple agent forms on one execution architecture.

| Mode | Current path | Meaning |
|---|---|---|
| Managed | `ManagedBehaviorFactory` | `.rg` zones executed by the runtime |
| Custom / external | `CustomBehaviorFactory` | user-defined or provider-defined behavior |
| Gate-backed | `GateBehaviorFactory` | proxy behavior across process boundaries |
| MCP-facing | `mcp-gate` | protocol participation through MCP clients |

<div class="mt-5 p-4 rounded-lg bg-blue-500/10 border border-blue-500/20 text-center">
  One protocol-governed execution model across multiple runtime shapes.
</div>

---
transition: slide-left
---

# Distributed by design

Reagent is not tied to one process or one transport.

From the current architecture:

- node-local execution lives in `ReagentController`
- shared cluster truth lives in `StateStore`
- the message plane uses `NodeLink`
- the control plane uses `AdminClient` and per-node endpoints

| Layer | Current options |
|---|---|
| Message plane | in-memory, WebSocket, NATS |
| Cluster truth | in-memory, etcd |
| Runtime hosts | local nodes, `mcp-gate`, Claude host, test hosts |

<div class="mt-5 text-center text-sm opacity-70">
This makes wide agent networks possible without collapsing everything into one monolithic orchestrator.
</div>

---
transition: slide-left
---

# Verification matters

Agent systems need stronger guarantees than "it usually works".

Reagent provides a verification path through:

- protocol-first choreography
- explicit control-flow constructs
- `verify` pipeline that generates TLA+ artifacts
- TLC execution when available

<div class="mt-8 p-5 rounded-xl bg-green-500/10 border border-green-500/20">
  <div class="font-bold text-green-300">The point is not academic formalism.</div>
  <div class="text-sm mt-3 opacity-80">
    The point is to make coordination logic inspectable and analyzable before it becomes a production incident.
  </div>
</div>

---
transition: slide-left
---

# Observability is part of the model

Reagent is designed to integrate with operational telemetry.

Current hooks include:

- message-level OpenTelemetry interception
- trace/event-level OpenTelemetry hooks

```mermaid {scale: 0.72}
flowchart LR
    S["Protocol state transitions"] --> M["Message spans"]
    S --> T["Trace events"]
    M --> D["Dashboards / traces / debug workflows"]
    T --> D
    style S fill:#1e3a5f,stroke:#60a5fa,color:#fff
    style M fill:#1f4d3a,stroke:#34d399,color:#fff
    style T fill:#3f1f5f,stroke:#c084fc,color:#fff
    style D fill:#4a3419,stroke:#fb923c,color:#fff
```

<div class="mt-4 text-center text-sm opacity-70">
Reliable agent systems need protocol traces, not only model outputs.
</div>

---
transition: slide-left
---

# Capability-aware interaction

Current Reagent already supports agent metadata:

- tags
- capabilities
- labels

These feed resolve-time selection today.

Future `agent type` docs take the next step:

- agents declare what they can **consume**
- agents declare what they can **produce**
- the runtime can negotiate richer target-aware message forms

| Today | Future direction |
|---|---|
| resolve-time matching | full capability-aware interaction model |
| metadata on agent records | capabilities on agent types |
| mostly transport/runtime selection | content negotiation and response shaping |

---
transition: slide-left
---

# Why this matters strategically

The strongest Reagent use cases are not toy demos.

They are environments where agent communication must be:

- constrained
- observable
- governable
- distributable
- trustworthy

<div class="grid grid-cols-3 gap-4 mt-6">
  <div class="p-4 rounded-xl bg-blue-500/10 border border-blue-500/20 text-center">
    <div class="font-bold text-blue-300">Medicine</div>
    <div class="text-sm mt-2 opacity-75">approval paths, audit trails, bounded communication</div>
  </div>
  <div class="p-4 rounded-xl bg-green-500/10 border border-green-500/20 text-center">
    <div class="font-bold text-green-300">Banking / finance</div>
    <div class="text-sm mt-2 opacity-75">compliance, escalation, verifiable workflows, risk controls</div>
  </div>
  <div class="p-4 rounded-xl bg-purple-500/10 border border-purple-500/20 text-center">
    <div class="font-bold text-purple-300">Inter-org systems</div>
    <div class="text-sm mt-2 opacity-75">wide protocol-governed networks across organizational boundaries</div>
  </div>
</div>

---
transition: slide-left
---

# Present and future fit together

The current docs already support the core story:

- protocol-first control
- RC-based distributed runtime
- heterogeneous agent hosting
- verification path through TLA+
- OpenTelemetry integration

The future docs extend that story through:

- `agent type`
- stronger scatter/gather semantics
- distributed `try/catch`
- richer resolve policies
- broader runtime-platform options

<div class="mt-6 p-4 rounded-lg bg-gray-800/50 text-center">
  Reagent is not only a language for agents.
  It is a path toward <strong>reliable agent infrastructure</strong>.
</div>

---
layout: center
class: text-center
---

# Reagent

<div class="text-2xl opacity-85 mt-4">
Not just more autonomous loops.
</div>

<div class="text-3xl font-bold text-blue-300 mt-6">
An agentic control plane with protocol-bounded interaction.
</div>

<div class="mt-8 text-lg opacity-65">
Build agents that can coordinate at scale without giving up control.
</div>
