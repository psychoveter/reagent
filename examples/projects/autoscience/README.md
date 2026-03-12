# autoscience — automated research process

Reagent protocol for an automated research cycle with four roles:

- **Human** — the person: sets research direction, approves key decisions, corrects course
- **Lead** (LLM, e.g. Claude Code) — research orchestrator: aggregates information from all agents, builds summaries, proposes next steps to human
- **Consultant** (LLM, e.g. Claude Code) — systematizer-critic: formalizes intuitions, critiques claims, writes experiment specs and documents
- **Researcher** (LLM, e.g. Claude Code) — experimenter: runs computational experiments, returns results

Multiple consultants and researchers can participate simultaneously (scatter).

## Information flow

```
Human ◄──► Lead ──► Consultant(s)
                ──► Researcher(s)
```

Human never talks directly to consultants or researchers. Lead aggregates and summarizes all information before presenting it to the human for decisions. This keeps the human's cognitive load manageable while allowing parallel work across multiple LLM agents.

## Research cycle

The process follows a loop. At each iteration, Lead summarizes the current state and the human chooses one of four actions:

```
┌─────────────────────────────────────────────────────────────┐
│                    ResearchCycle (main loop)                 │
│                                                             │
│  Intuition → Formalize → [loop: human decides cycle type]   │
│                                                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │   Critique    │  │  Experiment   │  │    Expansion     │  │
│  │              │  │              │  │                  │  │
│  │ scatter      │  │ spec →       │  │ scatter          │  │
│  │ consultants  │  │ human ok →   │  │ consultants →    │  │
│  │ → aggregate  │  │ scatter      │  │ aggregate →      │  │
│  │ → human      │  │ researchers  │  │ human selects    │  │
│  │   decides    │  │ → interpret  │  │                  │  │
│  │ → fixation   │  │ → human ok   │  │                  │  │
│  │              │  │ → fixation   │  │                  │  │
│  └──────────────┘  └──────────────┘  └──────────────────┘  │
│                                                             │
│  Human decides "stop" → final fixation → final report       │
└─────────────────────────────────────────────────────────────┘
```

## Sub-protocols

| Protocol | Invoked by | Purpose |
|----------|-----------|---------|
| `Formalize` | consultant | Turns an intuition into a formal claim with predictions and falsification criteria |
| `Critique` | consultant | Identifies weaknesses, counter-examples, and improvement suggestions |
| `ExperimentRun` | researcher | Executes a computational experiment per specification, returns data and verdict |
| `Fixation` | consultant | Produces a versioned document reflecting current state of claims and results |

## Message design for MCP Gate

Messages are passed without boilerplate `onSend`/`onReceive` hooks wherever possible. When an MCP Gate agent receives a message, the entire payload arrives as part of the `ProtocolEvent`:

```json
{
  "type": "receive",
  "message": "CritiqueRequest",
  "payload": {"claims": [...], "documentVersion": "v3.1"}
}
```

The agent reasons about the payload directly and responds. Hooks are used only where the sender needs to construct the payload from `$ctx` (e.g. building a summary) or the receiver needs to update local state (e.g. pushing to a collection).

## MCP Gate integration

This project is designed as a reference example for the current MCP Gate runtime model described in [the user guide](../../../docs/current/01-user-guide.md) and [cluster/control-plane docs](../../../docs/current/04-cluster-and-control-plane.md).

In MCP Gate mode:
- **Lead, Consultant, Researcher** are Claude Code sessions connected via `McpGateTransport`
- Each session calls `reagent/register(agentName, roles)` and loops on `reagent/wait_for_events()`
- **Human** connects via MCP Gate with a human-in-the-loop `$agent` (presents summaries, collects decisions)

## Building

```bash
cd projects/reagent
node lang/dist/cli.js build examples/projects/autoscience
```

## Based on

Process ontology extracted from the "Polarization Principle" research program:
- `projects/montevideo/autoscience/research-process-meta_1.md`
- `projects/montevideo/autoscience/research-process-ontology.md`
