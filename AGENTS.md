# Reagent agent guide

## Project

Reagent is a protocol language and runtime for distributed and agentic
interactions. A `.rg` protocol makes participants, typed messages, triggers,
control flow, and interaction boundaries explicit. Host-language zones contain
local agent logic; the protocol defines the choreography that the runtime can
execute, inspect, verify, and audit.

This repository contains the language compiler, TypeScript runtime, examples,
tests, and VS Code tooling.

## Source of truth

The numbered files in `docs/current/` describe implemented behavior. Read:

1. `docs/current/00-registry.md` — status and documentation map
2. `docs/current/01-user-guide.md` — build, run, debug, deploy, verify
3. `docs/current/02-lang-spec.md` — authoritative syntax and semantics
4. `docs/current/03-runtime-core.md` — node-local execution model
5. `docs/current/04-cluster-and-control-plane.md` — cluster and control plane
6. `docs/current/05-versioning-and-reconcile.md` — fingerprints and reconcile
7. `docs/current/06-tooling-overview.md` — IDE, debug, diagrams, observability
8. `docs/current/07-lsp.md` — language server
9. `docs/current/08-test-spec.md` — test inventory and validation tiers
10. `docs/current/09-e2e-usecases.md` — canonical end-to-end scenarios

Priority rules:

- `02-lang-spec.md` wins for syntax and semantics.
- `01-user-guide.md` wins for user workflows and CLI ergonomics.
- `08-test-spec.md` wins for test scope and validation tiers.
- `docs/current/` wins over RFCs and exploratory notes in `docs/future/`.

## Current architecture

- TypeScript is the only first-class runtime.
- The parallel Python runtime was retired. Do not recreate it.
- The `[py]` language tag remains part of syntax and IR.
- `[py]` zone execution is isolated under `runtime/ts/zone-execs/py/`; this is
  virtual-language scaffolding owned by the TypeScript RC, not a Python runtime.
- Whole-agent `Role[py]` dispatch is deferred to the future Rust RC with
  PyO3/equivalent host bindings.
- Historical Python-runtime retirement material lives in
  `docs/archive/retire-python-runtime.md`.

Important language commitments:

- Reagent describes interactions, not hard-coded agent internals.
- Zones are real host-language code, not pseudocode.
- Participant language tags belong on participant declarations.
- `initiator` is a participant modifier, not a separate directive.
- Runtime bindings are `$ctx`, `$self`, `reagent`, and optional `$agent`.
- Do not reintroduce `$flow`; it is removed/deprecated.
- Current triggers are `invoke`, `cron`, and `event`.
- Static participants require explicit resolve behavior; dynamic participants
  do not.
- `reagent.json`, `reagent.lock`, fingerprints, `build`, and `deploy` are part
  of the current project model.

## Repository layout

```text
docs/current/                 canonical implemented-state documentation
docs/future/                  RFCs, backlog, and exploratory plans
docs/archive/                 historical documents
lang/                         parser, AST, validator, IR, CLI, decompiler
examples/protocols/src/       canonical protocol-only .rg fixtures
examples/out/                 compiled fixtures consumed by tests
examples/projects/            complete Reagent projects with their own out/
runtime/agents/               standalone agent hosts
runtime/ts/src/
  contracts/                  shared interfaces and wire types
  core/                       execution primitives
  controller/                 ReagentController and registries
  nodes/                      managed, custom, gate, MCP, Claude adapters
  cluster/                    state store, membership, bootstrap
  triggers/                   matching, cron, resolve policies
  network/                    NodeLink implementations
  admin/                      control plane, deploy, inspect, debug, reconcile
  observability/              OTel integration
  support/                    runtime support utilities
runtime/ts/test/              package-level cluster and host tests
runtime/ts/zone-execs/py/     isolated [py] zone executor
runtime/tests/                controller/core/trigger/contract/story tests
tools/reagent-vscode/         extension, grammar, LSP, debug, diagrams
```

The root of `runtime/ts/src/` should contain only package entrypoints such as
`index.ts`, `main.ts`, and `rgctl.ts`; implementation belongs in layer folders.

## Working on the language

Use an examples-first, test-driven workflow for changes to `.rg` syntax or
language-facing semantics:

1. State whether the change affects syntax, semantics, or both; identify
   compatibility expectations and affected compiler/runtime/tooling surfaces.
2. Update canonical `.rg` fixtures in `examples/protocols/src/` first. For
   project-shaped behavior, update a project under `examples/projects/`.
3. Keep compiler, runtime, tools, docs, and tests synchronized:
   - `lang/src/` — parser, AST, validation, IR, decompiler, CLI
   - `runtime/ts/src/` — execution semantics
   - `tools/reagent-vscode/syntaxes/reagent.tmLanguage.json` — highlighting
   - `tools/reagent-vscode/server/` — LSP
   - `tools/reagent-vscode/src/` — extension behavior
4. Rebuild and recompile early:

   ```bash
   npm run build:lang
   npm run compile:examples
   ```

5. Add the narrowest test that proves the behavior, then widen validation in
   proportion to the affected subsystem.
6. Update the corresponding numbered document in `docs/current/`.

Do not present old and new syntax as simultaneously current unless the change
is explicitly additive.

## Generated fixtures

Protocol fixtures compile to `examples/out/<protocol>/`; complete projects
build to their own `out/`. Runtime tests consume these generated artifacts, so
regenerate and include them when language or IR output changes.

Useful direct commands:

```bash
node lang/dist/cli.js parse <file.rg>
node lang/dist/cli.js validate <file.rg>
node lang/dist/cli.js compile <file.rg> examples/out/<name>
node lang/dist/cli.js build examples/projects/<project>
node lang/dist/cli.js decompile <dir-or-ir>
node lang/dist/cli.js verify <file.rg>
```

## Tests

Do not assume `npm test` covers every repository surface. Choose focused tests
first, then expand according to `docs/current/08-test-spec.md`.

Common commands from the repository root:

```bash
# Build and fixtures
npm run build:lang
npm run build:runtime
npm run build
npm run compile:examples
npm run validate:examples

# Language
npm run test:lang:surface
npm run test:lang:compiler
npm run test:lang

# Runtime
npm run test:runtime:fast
npm run test:runtime:cluster
npm run test:runtime:hosts
npm run test:runtime:controller
npm run test:runtime:core
npm run test:runtime:triggers
npm run test:runtime:contracts
npm run test:runtime

# Stories and tools
npm run test:stories
npm run test:stories:nats
npm run test:stories:debug
npm run test:stories:live
npm run test:tooling:lsp

# Aggregates
npm run test:fast
npm run test:default
npm run test:all
npm run check
npm run check:all
```

`test:stories:nats`, live stories, and some cluster tests require external
infrastructure. Distinguish code failures from unavailable NATS, etcd, Docker,
TLC, credentials, or live model services.

## Documentation discipline

Update documentation in the same change when behavior changes:

- language surface → `02-lang-spec.md`
- execution semantics → `03-runtime-core.md`
- cluster/control plane → `04-cluster-and-control-plane.md`
- versions/fingerprints/reconcile → `05-versioning-and-reconcile.md`
- IDE/debug/tooling → `06-tooling-overview.md` and `07-lsp.md`
- tests and validation policy → `08-test-spec.md`
- story-level behavior → `09-e2e-usecases.md`
- documentation set or reading order → `00-registry.md`

Stable constructs need automated coverage, not only examples or prose.

## Completion checklist

For language-facing work, report:

- changed examples, compiler/runtime, tooling, docs, and tests;
- commands run and their pass/fail status;
- compatibility or breaking-change implications;
- whether generated IR, versions, lockfiles, or fingerprints changed;
- anything intentionally provisional or deferred.
