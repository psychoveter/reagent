/**
 * Tests for parser error reporting at the protocol-body level.
 *
 * Run: node --import tsx --test test/surface/parser-errors.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseProgram } from "../../src/parser.js";

describe("parser errors", () => {
  it("rejects bare `break` at protocol level with E_PROTOCOL_BREAK", () => {
    const src = `
      protocol P {
        participants:
          a [ts] initiator
        trigger on invoke with M {
          resolve a = single
        }
        loop ($ctx.attempt < 3) {
          a { $ctx.attempt += 1 }
          break
        }
      }
    `;
    const res = parseProgram(src);
    assert.equal(res.ok, false, "expected parse error");
    const e = res.errors.find(err => err.code === "E_PROTOCOL_BREAK");
    assert.ok(e, `expected E_PROTOCOL_BREAK in errors, got ${JSON.stringify(res.errors)}`);
    assert.match(e!.message, /reagent\.break\(\)/);
  });

  it("interleaved parses with different participant langs do not leak state", () => {
    const tsSrc = `
      protocol P {
        participants:
          a [ts] initiator
        trigger on invoke with M {
          resolve a = single
        }
        a { $ctx.x = 1 }
      }
    `;
    const pySrc = `
      protocol Q {
        participants:
          a [py] initiator
        trigger on invoke with M {
          resolve a = single
        }
        a { $ctx.x = 1 }
      }
    `;
    // Interleave: parse first program partway, then parse second, then finish.
    // In practice we drive both to completion and assert the per-parse zone
    // langs are derived from each program's own participants.
    const r1 = parseProgram(tsSrc);
    const r2 = parseProgram(pySrc);
    assert.equal(r1.ok, true, JSON.stringify(r1.errors));
    assert.equal(r2.ok, true, JSON.stringify(r2.errors));

    const proto1 = r1.ast.items.find(it => it.kind === "ProtocolDef");
    const proto2 = r2.ast.items.find(it => it.kind === "ProtocolDef");
    assert.ok(proto1 && proto1.kind === "ProtocolDef");
    assert.ok(proto2 && proto2.kind === "ProtocolDef");
    if (proto1 && proto1.kind === "ProtocolDef" && proto2 && proto2.kind === "ProtocolDef") {
      const z1 = proto1.body.find(it => it.kind === "AgentZone") as { lang: string } | undefined;
      const z2 = proto2.body.find(it => it.kind === "AgentZone") as { lang: string } | undefined;
      assert.equal(z1?.lang, "ts");
      assert.equal(z2?.lang, "py");
    }
  });

  it("emits E_TRIGGER_AS_DEPRECATED warning for `trigger on invoke as MsgType` but keeps parsing", () => {
    const src = `
      protocol P {
        participants:
          a [ts] initiator
        trigger on invoke as M {
          resolve a = single
        }
        a { $ctx.x = 1 }
      }
    `;
    const res = parseProgram(src);
    assert.equal(res.ok, true, `expected ok=true (warning only), got ${JSON.stringify(res.errors)}`);
    const w = res.errors.find(e => e.code === "E_TRIGGER_AS_DEPRECATED");
    assert.ok(w, "expected E_TRIGGER_AS_DEPRECATED warning");
    assert.equal(w!.severity, "warning");
  });

  it("does not emit E_TRIGGER_AS_DEPRECATED for canonical `with`", () => {
    const src = `
      protocol P {
        participants:
          a [ts] initiator
        trigger on invoke with M {
          resolve a = single
        }
        a { $ctx.x = 1 }
      }
    `;
    const res = parseProgram(src);
    assert.equal(res.ok, true);
    assert.equal(res.errors.find(e => e.code === "E_TRIGGER_AS_DEPRECATED"), undefined);
  });

  it("rejects reserved arrow kinds (`->`, `->>`, `-->>`) with E_RESERVED_ARROW", () => {
    for (const arrow of ["->", "->>", "-->>"] as const) {
      const src = `
        protocol P {
          participants:
            a [ts] initiator, b [ts]
          trigger on invoke with M {
            resolve a = single
            resolve b = single
          }
          a ${arrow} b: Hello
        }
      `;
      const res = parseProgram(src);
      assert.equal(res.ok, false, `expected error for arrow ${arrow}`);
      const e = res.errors.find(err => err.code === "E_RESERVED_ARROW");
      assert.ok(e, `expected E_RESERVED_ARROW for arrow ${arrow}, got ${JSON.stringify(res.errors)}`);
    }
  });

  it("rejects reserved arrows inside alt message guards", () => {
    const src = `
      protocol P {
        participants:
          a [ts] initiator, b [ts]
        trigger on invoke with M {
          resolve a = single
          resolve b = single
        }
        alt at a (b ->> a: Done) {
          a { $ctx.x = 1 }
        }
      }
    `;
    const res = parseProgram(src);
    assert.equal(res.ok, false);
    assert.ok(res.errors.some(e => e.code === "E_RESERVED_ARROW"));
  });

  it("recovers after a protocol-level break and keeps parsing the rest of the body", () => {
    const src = `
      protocol P {
        participants:
          a [ts] initiator, b [ts]
        trigger on invoke with M {
          resolve a = single
          resolve b = single
        }
        a --> b: First
        break
        b --> a: Second
      }
    `;
    const res = parseProgram(src);
    assert.equal(res.ok, false, "expected break to be rejected");
    assert.ok(
      res.errors.some(e => e.code === "E_PROTOCOL_BREAK"),
      "missing E_PROTOCOL_BREAK error",
    );
    const proto = res.ast.items.find(it => it.kind === "ProtocolDef");
    assert.ok(proto, "expected protocol parsed");
    assert.ok(proto && proto.kind === "ProtocolDef");
    if (proto && proto.kind === "ProtocolDef") {
      const messageNames = proto.body
        .filter(it => it.kind === "MessageStmt")
        .map(it => (it as { messageName: string }).messageName);
      assert.deepEqual(messageNames, ["First", "Second"]);
    }
  });
});
