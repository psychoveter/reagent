# Code-module imports (RFC)

Status: Future / not implemented | Date: 2026-05-05

This RFC tracks the proposed `.rg`-level **code-module import** syntax that
makes host-language helper modules available inside TS/JS/Kotlin agent zones
without going through `$agent`.

It was previously documented as if it were part of the v0 surface in
`02-lang-spec.md` §1.8, but no runtime path actually resolves the alias and
no example exercises it. This document captures the proposal so we can
implement it deliberately later.

---

## 1. Motivation

Today, the zone-side escape hatches are:

- **Python** (`[py]`): zone bodies are executed via `exec(...)`, so plain
  `import` / `from ... import ...` statements at the top of a zone work
  natively.
- **TypeScript / JavaScript / Kotlin**: zones run inside
  `new Function(...)` (or an analogous evaluation context) which does not
  support host-language `import` statements. The only documented escape is
  the `$agent` native module bound through `agent.json` (see §1.3.1 of the
  current spec).

This is asymmetric and forces every TS/JS/Kotlin agent that needs even tiny
helpers to ship them through a native module. The proposal is to allow:

```rg
import "./lib/helpers.ts" as helpers

protocol P {
  participants: a [ts] initiator
  trigger on invoke with M { resolve a = single }
  a {
    $ctx.result = helpers.computeHash($ctx.data)
  }
}
```

Inside the `a` zone, the alias `helpers` is the module's export object.

## 2. Proposed semantics

- **Build-time resolution.** During `reagent-lang build`, every
  `import "./*.<ts|js|kt>" as <alias>` is walked relative to the importing
  `.rg` file. The compiler:
  - confirms the file exists and has a matching extension for one of the
    supported langs (`ts`, `js`, `kt`);
  - records the alias and resolved module path on the protocol IR
    (`IRGraph.codeImports?: Array<{ alias, modulePath, lang }>`).
- **Runtime resolution.** At protocol-instance start, the runtime loader
  imports each referenced module once per RC and caches the export object
  by `(modulePath, lang)`. The cached export is then injected into every
  zone scope of every role on this protocol that matches the import's
  `lang`.
- **Zone scope wiring.** [`runtime/ts/src/core/zone-executor.ts`](../../runtime/ts/src/core/zone-executor.ts)
  already accepts an `extras: Record<string, unknown>` parameter that
  becomes additional named parameters on the generated `new Function(...)`.
  The runtime appends the resolved aliases alongside the existing `$agent`
  binding.
- **Static-only imports.** Aliases are bound once at zone construction time;
  they are not re-evaluated per call. This matches `$agent`.
- **Lang scoping.** A `[ts]`-extension import is only injected into TS/JS
  zones; a `[kt]` import only into Kotlin zones; etc. Mismatches are a
  build-time error.

## 3. Out of scope for v1

- Side-effecting imports (`import "./setup.ts"` without `as`).
- Hot-reloading on disk change.
- Tree-shaking unused aliases.
- Runtime evaluation of dynamic module specifiers.

## 4. Open questions

1. Should `agent.json` `module` and `import "./" as ...` overlap? Today
   `agent.json` is per-agent; imports would be per-protocol. The simplest
   rule: imports add named bindings *next to* `$agent`, never overriding it.
2. How do we surface alias collisions across multiple imports? Build error.
3. Do we want a `*` wildcard alias (`import "./helpers.ts" as *`) that
   merges the export's keys directly into the zone scope? Probably not —
   it makes static analysis harder.
4. Do we relax the rule and let Python zones use the same syntax for parity?
   Likely yes, but Python already has `import`, so the marginal benefit is
   small.

## 5. Migration

Until this RFC lands:

- TS/JS/Kotlin agents that need shared helpers ship them through `$agent`.
- Examples and the user guide should not show `import "./*.ts" as ...`.

When this RFC lands:

- Add a `codeImports` array to `IRGraph` and `deployment.json`.
- Add fixtures under `examples/protocols/src/` exercising the new syntax.
- Update `02-lang-spec.md` §1.8 to fold this back into the current surface.
