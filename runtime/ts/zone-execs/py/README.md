# `[py]` zone executor

Python helper invoked by the TS Reagent Controller to execute `[py]`-tagged
zone bodies. **Not** a runtime — just the zone executor primitives.

## Scope

- `execute_zone(body, ctx, self_state, reagent, extras)` — sync zone bodies.
- `execute_zone_async(body, ctx, self_state, reagent, extras)` — `await`-bearing
  zone bodies.
- `AttrDict`, `ReagentStub`, `InvokeRequest`, `ReturnValue`, `BreakRequest`
  helpers consumed by the zone bodies.

## Why this exists

`LangTag = "ts" | "js" | "py" | "kt"` remains part of the Reagent language
surface and IR. When a zone is tagged `[py]`, the RC needs a way to execute
the raw Python body. This package provides that single capability with no
dependency on the (now-retired) parallel Python runtime.

The TS RC currently exercises this path only in
`runtime/ts/test/core/agent-host-boundary.test.ts` (tests `A2` / `A4`),
which spawn `python3 -c "..."` and import from this package.

## Future

Full whole-agent-on-`[py]` dispatch (i.e. `agent X runs Role[py]`) is unsupported
until the Rust RC lands with PyO3 / equivalent host bindings.
