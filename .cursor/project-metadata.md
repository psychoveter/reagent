# Reagent — project metadata (prototype)

Path: `/Users/Oleg.Bukhvalov/projects/cyclon/projects/reagent`

## Idea / purpose

Reagent is a prototype of a **library + toolchain** for implementing *agentic / distributed protocols*.

Core problem it targets:

- In distributed programming there is often **no single artifact** that describes the distributed algorithm (“the protocol”).
- Instead you typically have separate implementations per side/role (client/server/worker/etc.), which makes it harder to:
  - review the whole protocol,
  - render it,
  - evolve it safely,
  - reuse it as knowledge for planning/reasoning.

Reagent’s approach:

- Use a **single protocol artifact** written in a DSL that is both human-readable and renderable.
- **Mermaid sequence diagrams** are a good fit as a base: syntax is compact, and there are many existing renderers.
- Mix protocol text and code, “React-like”: **protocol + function blocks** in one file (analogy: `jsx` mixing HTML + JS).

## Protocol artifact (“reagent file”)

A reagent protocol file defines:

- **Roles/agents** (participants of the protocol).
- The **protocol** itself as a sequence (Mermaid `sequenceDiagram`-like syntax).
- Optional **code blocks** (functions/handlers) used by the protocol.
- For each role: the **target language** for compilation (for MVP: **Python** as the main language).

Conceptually:

- Protocol = *distributed algorithm specification*.
- Functions = *local computations/tools used at steps*.

## Compilation model (key design)

Compiler responsibilities:

- Parse protocol DSL (+ code blocks).
- Generate a **state machine per participant** (role) in the role’s target language.
  - Each participant gets *its own* compiled artifact.
  - The state machine encodes the local view of the global protocol:
    - expected inbound/outbound messages,
    - local actions to run (functions/tools/LLM calls),
    - waits/guards/timeouts (as supported by DSL).
- Optionally generate shared artifacts:
  - protocol AST / IR,
  - typed message schemas,
  - test harness / simulators.

Runtime responsibilities:

- Provide an **execution engine** that can consume the compiled state machine for a participant.
- Integrate with:
  - transport (in-process, IPC, network),
  - tool/function invocation,
  - (optional) LLM invocation,
  - tracing/logging,
  - persistence (session state).

For now, assume:

- **Python runtime** is the primary target (“main reagent language”).

## Intended use in CognOS

Reagent is intended to be used in CognOS as:

- **(a) A language for angels communication**
  - Protocols define allowed/expected interaction patterns between angels/daemons (and maybe proc).
  - Helps keep coordination deterministic/auditable.

- **(b) A knowledge base used by angels**
  - A “protocol database” can be queried/used by angels such as:
    - **comma**: communication policies and interaction patterns.
    - **plana**: planning templates / coordination plans.
  - Protocols become re-usable “procedural knowledge” for planning (not just code).

## MVP scope (suggested)

- **File format**:
  - Mermaid-ish `sequenceDiagram` for protocol.
  - Embedded `functions` blocks per role (Python first).
  - Explicit role declarations: `role name`, `language`, (optional) capabilities.

- **Compiler**:
  - Parse -> IR -> generate Python state machine per role.
  - Deterministic codegen (stable output).

- **Runtime (Python)**:
  - Load compiled state machine.
  - Execute until “wait for message” / “wait for user input” / “done”.
  - Pluggable invokers: `tool(name, input)`, `llm(prompt)`, `fn(name, args)`.
  - Session state: vars + frame/pc per role.

- **Rendering / UX**:
  - Use Mermaid rendering for protocol visualization.

## Open questions / design choices (capture early)

- **Protocol DSL surface**:
  - How to represent conditionals (`opt/alt`), loops, timeouts, retries?
  - How to represent message schemas / validation (zod/pydantic-like)?

- **Compilation semantics**:
  - How to map global steps to per-role state transitions (especially for `alt/loop`)?
  - How to represent “shared variables” vs role-local variables?

- **Execution semantics**:
  - Is runtime cooperative (step-by-step) or event-driven?
  - What is the transport abstraction (channels, inbox/outbox, correlation ids)?

- **Safety**:
  - If LLM is used, what is allowed to be non-deterministic, and how is it bounded/audited?

## References (existing prototype in this workspace)

There is an existing TypeScript prototype inside:

- `projects/obsidian-plugin/packages/reagent`

It already demonstrates:

- Mermaid `sequenceDiagram` parsing
- `.mmdx` doc parsing (`<protocol>`, `<functions>`)
- codegen of `.mmdx` → TS modules
- a deterministic runner core in TS

This `projects/reagent/` folder is the **separate** project space for the next iteration (Python-first compiler+runtime), with a clearer “protocol → per-participant state machines” goal.

