# RC Conformance Suite

IR fixtures and expected trace sequences for verifying that all three
integration modes (Managed, Custom, Gate) produce equivalent behavior.

## Structure

- `fixtures/` — IR graph JSON files for test protocols
- `expected/` — Expected trace event sequences (JSON arrays)
- `runner.ts` — Conformance test runner (TS)
- `runner.py` — Conformance test runner (Python)

## Running

```bash
npx tsx spec/conformance/runner.ts
python spec/conformance/runner.py
```
