/**
 * Tests for Phase 2: trigger parsing, IR emission, and validation.
 *
 * Run: npx tsx test/surface/triggers.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseProgram } from "../../src/parser.js";
import { emitIR, resetIdCounter } from "../../src/ir-emitter.js";
function parse(src) {
    const res = parseProgram(src);
    assert.ok(res.ok, `Parse failed: ${JSON.stringify(res.errors)}`);
    const proto = res.ast.items.find((i) => i.kind === "ProtocolDef");
    assert.ok(proto, "No protocol found");
    return proto;
}
function emit(proto) {
    resetIdCounter();
    return emitIR(proto);
}
// ── Parsing ─────────────────────────────────────────────────────────
describe("trigger parsing", () => {
    it("parses trigger on invoke without body", () => {
        const proto = parse(`
      message M {}
      protocol P {
        participants:
          w [py] initiator
        trigger on invoke with M {
          resolve w = single
        }
        w { $ctx.x = 1 }
      }
    `);
        assert.equal(proto.triggers.length, 1);
        const t = proto.triggers[0];
        assert.equal(t.triggerKind, "invoke");
        assert.equal(t.withType, "M");
        assert.equal(t.inputExpr, undefined);
        assert.equal(t.cronExpr, undefined);
        assert.equal(t.topic, undefined);
    });
    it("parses trigger on invoke with transform body", () => {
        const proto = parse(`
      message M {}
      protocol P {
        participants:
          w [py] initiator
        trigger on invoke with M {
          resolve w = single
          $ctx.input = { wrapped: $ctx.input }
        }
        w { $ctx.x = 1 }
      }
    `);
        assert.equal(proto.triggers.length, 1);
        const t = proto.triggers[0];
        assert.equal(t.triggerKind, "invoke");
        assert.equal(t.withType, "M");
        assert.ok(t.inputExpr.includes("$ctx.input"));
    });
    it("parses trigger on cron without body", () => {
        const proto = parse(`
      message M {}
      protocol P {
        participants:
          w [py] initiator
        trigger on cron "0 9 * * MON" {
          resolve w = single
        }
        w { $ctx.x = 1 }
      }
    `);
        assert.equal(proto.triggers.length, 1);
        const t = proto.triggers[0];
        assert.equal(t.triggerKind, "cron");
        assert.equal(t.cronExpr, "0 9 * * MON");
        assert.equal(t.withType, undefined);
        assert.equal(t.inputExpr, undefined);
    });
    it("parses trigger on cron with transform body", () => {
        const proto = parse(`
      message M {}
      protocol P {
        participants:
          w [py] initiator
        trigger on cron "0 9 * * MON" {
          resolve w = single
          $ctx.input = { day: $ctx.input.firedAt }
        }
        w { $ctx.x = 1 }
      }
    `);
        assert.equal(proto.triggers.length, 1);
        const t = proto.triggers[0];
        assert.equal(t.triggerKind, "cron");
        assert.equal(t.cronExpr, "0 9 * * MON");
        assert.equal(t.withType, undefined);
        assert.ok(t.inputExpr.includes("$ctx.input.firedAt"));
    });
    it("rejects trigger on cron with explicit type", () => {
        const res = parseProgram(`
      message M {}
      protocol P {
        participants:
          w [py] initiator
        trigger on cron "0 9 * * MON" with M {
          resolve w = single
          $ctx.input = $ctx.input
        }
        w { $ctx.x = 1 }
      }
    `);
        assert.ok(!res.ok || !res.ast.items.some((i) => i.kind === "ProtocolDef" && i.triggers.some(t => t.triggerKind === "cron" && t.withType !== undefined)), "cron trigger should not accept a with clause");
    });
    it("parses trigger on event without body", () => {
        const proto = parse(`
      message M {}
      protocol P {
        participants:
          w [py] initiator
        trigger on event "order.created" with M {
          resolve w = single
        }
        w { $ctx.x = 1 }
      }
    `);
        assert.equal(proto.triggers.length, 1);
        const t = proto.triggers[0];
        assert.equal(t.triggerKind, "event");
        assert.equal(t.topic, "order.created");
        assert.equal(t.withType, "M");
        assert.equal(t.inputExpr, undefined);
    });
    it("parses multiple triggers", () => {
        const proto = parse(`
      message M {}
      protocol P {
        participants:
          w [py] initiator
        trigger on invoke with M {
          resolve w = single
        }
        trigger on cron "*/5 * * * *" {
          resolve w = single
        }
        trigger on event "sys.start" with M {
          resolve w = single
        }
        w { $ctx.x = 1 }
      }
    `);
        assert.equal(proto.triggers.length, 3);
        assert.equal(proto.triggers[0].triggerKind, "invoke");
        assert.equal(proto.triggers[1].triggerKind, "cron");
        assert.equal(proto.triggers[2].triggerKind, "event");
        assert.equal(proto.triggers[0].inputExpr, undefined);
        assert.equal(proto.triggers[1].inputExpr, undefined);
        assert.equal(proto.triggers[2].inputExpr, undefined);
    });
});
// ── IR emission ─────────────────────────────────────────────────────
describe("trigger IR emission", () => {
    it("emits TriggerIR for invoke (no inputExpr)", () => {
        const proto = parse(`
      message M {}
      protocol P {
        participants:
          w [py] initiator
        trigger on invoke with M {
          resolve w = single
        }
        w { $ctx.x = 1 }
      }
    `);
        const result = emit(proto);
        assert.ok(result.ok, `Emit errors: ${result.errors}`);
        const graph = result.graphs.values().next().value;
        assert.ok(graph.triggers);
        assert.equal(graph.triggers.length, 1);
        assert.equal(graph.triggers[0].kind, "invoke");
        assert.equal(graph.triggers[0].withType, "M");
        assert.equal(graph.invocable, true);
    });
    it("emits TriggerIR with inputExpr when body present", () => {
        const proto = parse(`
      message M {}
      protocol P {
        participants:
          w [py] initiator
        trigger on invoke with M {
          resolve w = single
          $ctx.input = { v: $ctx.input.x }
        }
        w { $ctx.x = 1 }
      }
    `);
        const result = emit(proto);
        assert.ok(result.ok);
        const graph = result.graphs.values().next().value;
        assert.ok(graph.triggers[0].inputExpr.includes("$ctx.input.x"));
    });
    it("emits TriggerIR for all 3 kinds", () => {
        const proto = parse(`
      message M {}
      protocol P {
        participants:
          w [py] initiator
        trigger on invoke with M {
          resolve w = single
        }
        trigger on cron "0 9 * * MON" {
          resolve w = single
        }
        trigger on event "topic.x" with M {
          resolve w = single
        }
        w { $ctx.x = 1 }
      }
    `);
        const result = emit(proto);
        assert.ok(result.ok);
        const graph = result.graphs.values().next().value;
        assert.equal(graph.triggers.length, 3);
        assert.equal(graph.triggers[0].kind, "invoke");
        assert.equal(graph.triggers[1].cron, "0 9 * * MON");
        assert.equal(graph.triggers[1].withType, undefined);
        assert.equal(graph.triggers[2].topic, "topic.x");
        assert.equal(graph.invocable, true);
    });
    it("invocable is false when no invoke trigger", () => {
        const proto = parse(`
      message M {}
      protocol P {
        participants:
          w [py] initiator
        trigger on cron "0 * * * *" {
          resolve w = single
        }
        w { $ctx.x = 1 }
      }
    `);
        const result = emit(proto);
        assert.ok(result.ok);
        const graph = result.graphs.values().next().value;
        assert.equal(graph.invocable, false);
    });
});
// ── Compiler validation ─────────────────────────────────────────────
describe("trigger validation", () => {
    it("rejects protocol with no triggers", () => {
        const proto = parse(`
      protocol P {
        participants:
          w [py] initiator
        w { $ctx.x = 1 }
      }
    `);
        const result = emit(proto);
        assert.equal(result.ok, false);
        assert.ok(result.errors.some(e => e.includes("no triggers")));
    });
    it("accepts protocol with at least one trigger", () => {
        const proto = parse(`
      message M {}
      protocol P {
        participants:
          w [py] initiator
        trigger on invoke with M {
          resolve w = single
        }
        w { $ctx.x = 1 }
      }
    `);
        const result = emit(proto);
        assert.ok(result.ok, `Unexpected errors: ${result.errors}`);
    });
});
// ── Fingerprint stability ───────────────────────────────────────────
describe("trigger fingerprint", () => {
    it("different triggers produce different structure hashes", async () => {
        const { computeStructureHash } = await import("../../src/ir-fingerprint.js");
        const proto1 = parse(`
      message M {}
      protocol P {
        participants:
          w [py] initiator
        trigger on invoke with M {
          resolve w = single
        }
        w { $ctx.x = 1 }
      }
    `);
        const proto2 = parse(`
      message M {}
      protocol P {
        participants:
          w [py] initiator
        trigger on cron "0 9 * * MON" {
          resolve w = single
        }
        w { $ctx.x = 1 }
      }
    `);
        const r1 = emit(proto1);
        const r2 = emit(proto2);
        const hash1 = computeStructureHash(r1.graphs);
        const hash2 = computeStructureHash(r2.graphs);
        assert.notEqual(hash1, hash2, "Different trigger kinds should produce different hashes");
    });
    it("same triggers produce same structure hash", async () => {
        const { computeStructureHash } = await import("../../src/ir-fingerprint.js");
        const src = `
      message M {}
      protocol P {
        participants:
          w [py] initiator
        trigger on invoke with M {
          resolve w = single
        }
        w { $ctx.x = 1 }
      }
    `;
        const proto1 = parse(src);
        const proto2 = parse(src);
        const hash1 = computeStructureHash(emit(proto1).graphs);
        const hash2 = computeStructureHash(emit(proto2).graphs);
        assert.equal(hash1, hash2, "Identical protocols should have same hash");
    });
});
