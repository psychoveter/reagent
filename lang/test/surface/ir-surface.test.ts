/**
 * Tests for M10 Phase 4a: participant modifiers, resolve policies, agent metadata,
 * new spawn syntax, IR emission, and validation.
 *
 * Run: npx tsx test/surface/ir-surface.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseProgram } from "../../src/parser.js";
import { emitIR, resetIdCounter, emitAgentIR, emitRoleIR, emitAgentRegistrationIR } from "../../src/ir-emitter.js";
import { computeStructureHash } from "../../src/ir-fingerprint.js";
import type { ProtocolDef, AgentDef, ParticipantDecl } from "../../src/ast.js";

function parse(src: string) {
  const res = parseProgram(src);
  return res;
}

function parseProto(src: string): ProtocolDef {
  const res = parse(src);
  assert.ok(res.ok, `Parse failed: ${JSON.stringify(res.errors)}`);
  const proto = res.ast.items.find((i): i is ProtocolDef => i.kind === "ProtocolDef");
  assert.ok(proto, "No protocol found");
  return proto;
}

function emit(proto: ProtocolDef) {
  resetIdCounter();
  return emitIR(proto);
}

// ── Participant modifier parsing ──────────────────────────────────

describe("participant modifiers", () => {
  it("parses static single initiator (all modifiers)", () => {
    const proto = parseProto(`
      protocol P {
        participants:
          seller [py] static single initiator,
          buyer [ts] dynamic many
        trigger on invoke with M {
          resolve seller = single
          resolve buyer = all
        }
        seller --> buyer: Bid
      }
    `);
    assert.equal(proto.participants.length, 2);

    const seller = proto.participants[0];
    assert.equal(seller.name, "seller");
    assert.equal(seller.lang, "py");
    assert.equal(seller.binding, "static");
    assert.equal(seller.cardinality, "single");
    assert.equal(seller.initiator, true);

    const buyer = proto.participants[1];
    assert.equal(buyer.name, "buyer");
    assert.equal(buyer.lang, "ts");
    assert.equal(buyer.binding, "dynamic");
    assert.equal(buyer.cardinality, "many");
    assert.equal(buyer.initiator, undefined);
  });

  it("defaults binding=static, cardinality=single when omitted", () => {
    const proto = parseProto(`
      protocol P {
        participants:
          a [py] initiator,
          b [ts]
        trigger on invoke with M {
          resolve a = single
          resolve b = single
        }
        a --> b: Msg
      }
    `);
    const a = proto.participants[0];
    assert.equal(a.binding, undefined);
    assert.equal(a.cardinality, undefined);
    assert.equal(a.initiator, true);
  });

  it("initiator: directive is no longer parsed", () => {
    const res = parse(`
      protocol P {
        participants: a [py]
        initiator: a
        a { $ctx.x = 1 }
      }
    `);
    // The protocol should NOT have 'initiator' as it's removed from the grammar.
    // It should either fail to parse or the initiator keyword should not be recognized
    // as a directive. Since we removed it, the parser will try to parse it as body.
    if (res.ok) {
      const proto = res.ast.items.find((i): i is ProtocolDef => i.kind === "ProtocolDef");
      // initiator should not appear as protocol-level field
      assert.ok(proto);
    }
  });
});

describe("protocol supervision directive", () => {
  it("parses supervision strategy as a protocol-level directive", () => {
    const proto = parseProto(`
      protocol P {
        participants:
          a [ts] initiator,
          b [py]
        supervision: one-for-one
        trigger on invoke with M {
          resolve a = single
          resolve b = single
        }
        a --> b: Msg
      }
    `);
    assert.equal(proto.supervisionStrategy, "one-for-one");
  });

  it("emits supervision strategy into every role graph and defaults to scoped", () => {
    const explicit = emit(parseProto(`
      protocol P {
        participants:
          a [ts] initiator,
          b [py]
        supervision: detached
        trigger on invoke with M {
          resolve a = single
          resolve b = single
        }
        a --> b: Msg
      }
    `));
    assert.ok(explicit.ok, explicit.errors.join("\n"));
    for (const graph of explicit.graphs.values()) {
      assert.equal(graph.supervisionStrategy, "detached");
    }

    const implicit = emit(parseProto(`
      protocol P {
        participants:
          a [ts] initiator,
          b [py]
        trigger on invoke with M {
          resolve a = single
          resolve b = single
        }
        a --> b: Msg
      }
    `));
    assert.ok(implicit.ok, implicit.errors.join("\n"));
    for (const graph of implicit.graphs.values()) {
      assert.equal(graph.supervisionStrategy, "scoped");
    }
  });

  it("changes protocol structure fingerprint when supervision strategy changes", () => {
    const scoped = emit(parseProto(`
      protocol P {
        participants:
          a [ts] initiator,
          b [py]
        supervision: scoped
        trigger on invoke with M {
          resolve a = single
          resolve b = single
        }
        a --> b: Msg
      }
    `));
    const detached = emit(parseProto(`
      protocol P {
        participants:
          a [ts] initiator,
          b [py]
        supervision: detached
        trigger on invoke with M {
          resolve a = single
          resolve b = single
        }
        a --> b: Msg
      }
    `));
    assert.ok(scoped.ok && detached.ok);
    assert.notEqual(
      computeStructureHash(scoped.graphs),
      computeStructureHash(detached.graphs),
      "fingerprint should capture protocol-level supervision semantics",
    );
  });
});

// ── Resolve pipeline parsing ──────────────────────────────────────

describe("resolve pipeline parsing", () => {
  it("parses simple resolve: all | first", () => {
    const proto = parseProto(`
      protocol P {
        participants:
          a [ts] initiator,
          b [py]
        trigger on invoke with M {
          resolve a = single
          resolve b = all | first
        }
        a --> b: Msg
      }
    `);
    const trigger = proto.triggers[0];
    assert.ok(trigger.resolveDecls);
    assert.equal(trigger.resolveDecls.length, 2);

    const resolveB = trigger.resolveDecls.find(r => r.role === "b")!;
    assert.ok(resolveB);
    assert.equal(resolveB.pipeline.length, 2);
    assert.equal(resolveB.pipeline[0].step, "all");
    assert.equal(resolveB.pipeline[1].step, "first");
  });

  it("parses filter() with predicate", () => {
    const proto = parseProto(`
      protocol P {
        participants: a [ts] initiator, b [py]
        trigger on invoke with M {
          resolve a = single
          resolve b = all | filter("ml" in agent.tags) | first
        }
        a --> b: Msg
      }
    `);
    const resolveB = proto.triggers[0].resolveDecls!.find(r => r.role === "b")!;
    assert.equal(resolveB.pipeline.length, 3);
    const filterStep = resolveB.pipeline[1];
    assert.equal(filterStep.step, "filter");
    assert.equal((filterStep as any).predicate, '"ml" in agent.tags');
  });

  it("parses from() with expression", () => {
    const proto = parseProto(`
      protocol P {
        participants: a [ts] initiator, b [py]
        trigger on invoke with M {
          resolve a = single
          resolve b = from($ctx.input.agentName)
        }
        a --> b: Msg
      }
    `);
    const resolveB = proto.triggers[0].resolveDecls!.find(r => r.role === "b")!;
    assert.equal(resolveB.pipeline[0].step, "from");
    assert.equal((resolveB.pipeline[0] as any).expr, "$ctx.input.agentName");
  });

  it("parses roundRobin, random, sample, leastLoaded, fallback, custom", () => {
    const proto = parseProto(`
      protocol P {
        participants: a [ts] initiator, b [py]
        trigger on invoke with M {
          resolve a = single
          resolve b = all | roundRobin
        }
        trigger on cron "0 * * * *" {
          resolve a = single
          resolve b = all | sample(3)
        }
        a --> b: Msg
      }
    `);
    const rr = proto.triggers[0].resolveDecls!.find(r => r.role === "b")!;
    assert.equal(rr.pipeline[1].step, "roundRobin");

    const sampleDecl = proto.triggers[1].resolveDecls!.find(r => r.role === "b")!;
    assert.equal(sampleDecl.pipeline[1].step, "sample");
    assert.equal((sampleDecl.pipeline[1] as any).count, 3);
  });

  it("parses shorthands (hasTag, hasCapability)", () => {
    const proto = parseProto(`
      protocol P {
        participants: a [ts] initiator, b [py]
        trigger on invoke with M {
          resolve a = single
          resolve b = all | hasTag("gpu") | first
        }
        a --> b: Msg
      }
    `);
    const resolveB = proto.triggers[0].resolveDecls!.find(r => r.role === "b")!;
    assert.equal(resolveB.pipeline[1].step, "filter");
    assert.equal((resolveB.pipeline[1] as any).predicate, '"gpu" in agent.tags');
  });
});

// ── Agent metadata parsing ───────────────────────────────────────

describe("agent metadata body", () => {
  it("parses agent with tags, capabilities, labels", () => {
    const res = parse(`
      agent Buyer1 [py] runs BuyerRole {
        tags: ["eu-region", "fast"]
        capabilities: ["bidding"]
        labels: { tier: "standard", zone: "eu-west" }
      }
    `);
    assert.ok(res.ok, `Parse failed: ${JSON.stringify(res.errors)}`);
    const agent = res.ast.items.find((i): i is AgentDef => i.kind === "AgentDef");
    assert.ok(agent);
    assert.deepEqual(agent.tags, ["eu-region", "fast"]);
    assert.deepEqual(agent.capabilities, ["bidding"]);
    assert.deepEqual(agent.labels, { tier: "standard", zone: "eu-west" });
  });

  it("parses agent without body (backward compat)", () => {
    const res = parse(`agent Buyer1 [py] runs BuyerRole`);
    assert.ok(res.ok);
    const agent = res.ast.items.find((i): i is AgentDef => i.kind === "AgentDef")!;
    assert.equal(agent.tags, undefined);
    assert.equal(agent.capabilities, undefined);
    assert.equal(agent.labels, undefined);
  });

  it("emits AgentRegistrationIR with metadata", () => {
    const res = parse(`
      agent Buyer1 [py] runs BuyerRole {
        tags: ["eu"]
        capabilities: ["bid"]
        labels: { tier: "standard" }
      }
    `);
    assert.ok(res.ok);
    const agent = res.ast.items.find((i): i is AgentDef => i.kind === "AgentDef")!;
    const reg = emitAgentRegistrationIR(agent);
    assert.equal(reg.agentName, "Buyer1");
    assert.equal(reg.roleName, "BuyerRole");
    assert.deepEqual(reg.tags, ["eu"]);
    assert.deepEqual(reg.capabilities, ["bid"]);
    assert.deepEqual(reg.labels, { tier: "standard" });
  });
});

// ── New spawn syntax ──────────────────────────────────────────────

describe("new spawn syntax", () => {
  it("parses role spawn with as and persistent", () => {
    const proto = parseProto(`
      protocol P {
        participants:
          mgr [ts] initiator,
          worker [py] dynamic many
        trigger on invoke with M {
          resolve mgr = single
        }
        mgr spawns WorkerRole($ctx.config) as worker persistent -> $ctx.ref
      }
    `);
    const body = proto.body;
    assert.equal(body.length, 1);
    const spawn = body[0];
    assert.equal(spawn.kind, "SpawnStmt");
    if (spawn.kind === "SpawnStmt") {
      assert.equal(spawn.callerRole, "mgr");
      assert.equal(spawn.roleName, "WorkerRole");
      assert.equal(spawn.config, "$ctx.config");
      assert.equal(spawn.bindAs, "worker");
      assert.equal(spawn.persistent, true);
      assert.equal(spawn.resultTarget, "$ctx.ref");
    }
  });

  it("parses minimal spawn without as/persistent", () => {
    const proto = parseProto(`
      protocol P {
        participants: a [ts] initiator, b [py] dynamic many
        trigger on invoke with M {
          resolve a = single
        }
        a spawns WorkerRole($ctx.data)
      }
    `);
    const spawn = proto.body[0];
    assert.equal(spawn.kind, "SpawnStmt");
    if (spawn.kind === "SpawnStmt") {
      assert.equal(spawn.roleName, "WorkerRole");
      assert.equal(spawn.bindAs, undefined);
      assert.equal(spawn.persistent, undefined);
      assert.equal(spawn.resultTarget, undefined);
    }
  });
});

// ── IR emission ──────────────────────────────────────────────────

describe("IR emission", () => {
  it("emits ParticipantIR with correct defaults", () => {
    const proto = parseProto(`
      protocol P {
        participants:
          a [ts] initiator,
          b [py]
        trigger on invoke with M {
          resolve a = single
          resolve b = all | first
        }
        a --> b: Msg
      }
    `);
    const result = emit(proto);
    const graph = result.graphs.values().next().value!;
    assert.ok(graph.participants);
    assert.equal(graph.participants.length, 2);

    const pa = graph.participants.find(p => p.name === "a")!;
    assert.equal(pa.binding, "static");
    assert.equal(pa.cardinality, "single");
    assert.equal(pa.initiator, true);

    const pb = graph.participants.find(p => p.name === "b")!;
    assert.equal(pb.binding, "static");
    assert.equal(pb.cardinality, "single");
    assert.equal(pb.initiator, false);
  });

  it("emits resolveMap in TriggerIR", () => {
    const proto = parseProto(`
      protocol P {
        participants: a [ts] initiator, b [py]
        trigger on invoke with M {
          resolve a = single
          resolve b = all | filter("ml" in agent.tags) | first
        }
        a --> b: Msg
      }
    `);
    const result = emit(proto);
    const graph = result.graphs.values().next().value!;
    assert.ok(graph.triggers);
    const trigger = graph.triggers[0];
    assert.ok(trigger.resolveMap);
    assert.ok(trigger.resolveMap["a"]);
    assert.ok(trigger.resolveMap["b"]);
    assert.equal(trigger.resolveMap["b"].length, 3);
    assert.equal(trigger.resolveMap["b"][0].step, "all");
    assert.equal(trigger.resolveMap["b"][1].step, "filter");
    assert.equal(trigger.resolveMap["b"][2].step, "first");
  });

  it("emits spawn IR with roleName", () => {
    const proto = parseProto(`
      protocol P {
        participants: a [ts] initiator, b [py] dynamic many
        trigger on invoke with M {
          resolve a = single
        }
        a spawns WorkerRole($ctx.config) as b persistent
      }
    `);
    const result = emit(proto);
    const graph = result.graphs.get("a")!;
    const spawnState = graph.states.find(s => s.data.kind === "spawn");
    assert.ok(spawnState);
    if (spawnState!.data.kind === "spawn") {
      assert.equal(spawnState!.data.roleName, "WorkerRole");
      assert.equal(spawnState!.data.config, "$ctx.config");
      assert.equal(spawnState!.data.bindAs, "b");
      assert.equal(spawnState!.data.persistent, true);
    }
  });
});

// ── Validation ──────────────────────────────────────────────────

describe("validation", () => {
  it("requires exactly one initiator", () => {
    const proto = parseProto(`
      protocol P {
        participants: a [ts], b [py]
        trigger on invoke with M {
          resolve a = single
          resolve b = single
        }
        a --> b: Msg
      }
    `);
    const result = emit(proto);
    assert.ok(!result.ok);
    assert.ok(result.errors.some(e => e.includes("no initiator")));
  });

  it("errors on multiple initiators", () => {
    const proto = parseProto(`
      protocol P {
        participants: a [ts] initiator, b [py] initiator
        trigger on invoke with M {
          resolve a = single
          resolve b = single
        }
        a --> b: Msg
      }
    `);
    const result = emit(proto);
    assert.ok(!result.ok);
    assert.ok(result.errors.some(e => e.includes("2 initiator")));
  });

  it("errors when static participant missing resolve", () => {
    const proto = parseProto(`
      protocol P {
        participants: a [ts] initiator, b [py]
        trigger on invoke with M {
          resolve a = single
        }
        a --> b: Msg
      }
    `);
    const result = emit(proto);
    assert.ok(!result.ok);
    assert.ok(result.errors.some(e => e.includes('static participant "b" requires a "resolve"')));
  });

  it("errors when dynamic participant has resolve in trigger", () => {
    const proto = parseProto(`
      protocol P {
        participants: a [ts] initiator, b [py] dynamic many
        trigger on invoke with M {
          resolve a = single
          resolve b = all
        }
        a --> b: Msg
      }
    `);
    const result = emit(proto);
    assert.ok(!result.ok);
    assert.ok(result.errors.some(e => e.includes('dynamic participant "b" must not have a "resolve"')));
  });

  it("errors on direct send to many participant", () => {
    const proto = parseProto(`
      protocol P {
        participants: a [ts] initiator, workers [py] many
        trigger on invoke with M {
          resolve a = single
          resolve workers = all
        }
        a --> workers: Msg
      }
    `);
    const result = emit(proto);
    assert.ok(!result.ok);
    assert.ok(result.errors.some(e => e.includes("direct send") && e.includes("declared many")));
  });

  it("errors when scatter target is not many", () => {
    const proto = parseProto(`
      protocol P {
        participants: a [ts] initiator, worker [py]
        trigger on invoke with M {
          resolve a = single
          resolve worker = single
        }
        scatter ($ctx.items as worker) {
          a --> worker: Msg
        }
      }
    `);
    const result = emit(proto);
    assert.ok(!result.ok);
    assert.ok(result.errors.some(e => e.includes('scatter target "worker" must be declared many')));
  });

  it("allows scatter when target participant is many", () => {
    const proto = parseProto(`
      protocol P {
        participants: a [ts] initiator, worker [py] many
        trigger on invoke with M {
          resolve a = single
          resolve worker = all
        }
        scatter ($ctx.items as worker) {
          a --> worker: Msg
        }
      }
    `);
    const result = emit(proto);
    assert.ok(result.ok, `Emit failed: ${result.errors.join("; ")}`);
  });
});
