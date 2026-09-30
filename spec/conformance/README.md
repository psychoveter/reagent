# RC Conformance Suite

IR fixtures and expected trace sequences for verifying that all three
integration modes (Managed, Custom, Gate) produce equivalent behavior.

## Structure

- `fixtures/` — IR graph JSON files for test protocols
- `expected/` — Expected trace event sequences (JSON arrays)
- `runner.ts` — Conformance test runner (TS)

## Running

```bash
npx tsx spec/conformance/runner.ts
```
