# Reagent — project metadata

Path: `/Users/Oleg.Bukhvalov/projects/cyclon/projects/reagent`

## Idea / purpose

Reagent is a **language + toolchain** for implementing *agentic / distributed protocols*.

Core problem:
- In distributed programming there is often **no single artifact** that describes the distributed algorithm ("the protocol").
- Instead you typically have separate implementations per side/role, which makes it harder to review, debug, render, evolve, and reuse the protocol.

Approach:
- Use a **single protocol artifact** written in a dedicated DSL that is both human-readable and renderable.
- Mix protocol choreography and host-language code in one file ("React-like": `jsx` analogy).
- Compile protocol → per-participant **agent-level state machines** (IR) executable by pluggable engines.

## Documentation & Architecture Registry

The authoritative overview of Reagent's architecture, tools, and documentation can be found in the documentation registry:

👉 **[docs/current/reagent-registry.md](../docs/current/reagent-registry.md)**

Please refer to the registry for:
- High-level architecture and component diagrams
- Links to the Reagent language specification (`lang-spec.md`)
- Detailed design docs for the compiler, tooling, and runtime
- Roadmap and feature backlogs

## Development workflow

Development is **E2E test-driven**:
1. Write or extend a `.rg` example exercising the construct.
2. Compile with `reagent-lang compile`.
3. Add an E2E test case that runs agents, asserts trace and `$self` state.
4. Implement/extend reference runners to pass the test.
5. Update specs/docs.

## Intended use in CognOS

- **(a) Language for agent communication**: protocols define interaction patterns between angels/daemons.
- **(b) Knowledge base for planning**: protocols as reusable "procedural knowledge" for agents like comma (communication) and plana (planning).
