/**
 * M17 E2E: deterministic scheduled risk review with approval boundary.
 *
 * Covers one coherent TS-first story with:
 * - cron trigger
 * - protocol-level invoke
 * - role spawn
 * - approval/HITL boundary via a separate approver agent
 * - persistent state on the coordinator across the run
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { ReagentController } from "../ts/src/controller/reagent-controller.js";
import { NativeAgentNode, NativeAgentHandle } from "../ts/src/nodes/native-agent-node.js";
import { CustomAgentNode, CustomAgentHandle } from "../ts/src/nodes/custom-agent-node.js";
import { ManagedAgentAdapter } from "../ts/src/core/agent-interface.js";
import type { IRGraph, RoleIR } from "../ts/src/contracts/types.js";
import { parseProgram } from "../../lang/src/parser.js";
import { emitIR, emitRoleIR, resetIdCounter } from "../../lang/src/ir-emitter.js";
import type { ProtocolDef, RoleDef } from "../../lang/src/ast.js";

function compileSource(src: string): { graphs: Map<string, IRGraph>; roleIRs: Map<string, RoleIR> } {
  const res = parseProgram(src);
  assert.ok(res.ok, `Parse failed: ${res.errors.map((e) => e.message).join(", ")}`);

  const protocols = res.ast.items.filter((item): item is ProtocolDef => item.kind === "ProtocolDef");
  const roles = res.ast.items.filter((item): item is RoleDef => item.kind === "RoleDef");
  const roleMap = new Map<string, RoleDef>();
  for (const role of roles) roleMap.set(role.name, role);

  const graphs = new Map<string, IRGraph>();
  const roleIRs = new Map<string, RoleIR>();

  for (const proto of protocols) {
    resetIdCounter();
    const result = emitIR(proto);
    assert.ok(result.ok, `IR emit failed for ${proto.name}: ${result.errors.join(", ")}`);
    for (const [role, graph] of result.graphs) {
      graphs.set(`${proto.name}.${role}`, graph);
    }
  }

  for (const role of roles) {
    const result = emitRoleIR(role, roleMap);
    assert.ok(result.ok, `Role IR emit failed for ${role.name}: ${result.errors.join(", ")}`);
    roleIRs.set(role.name, result.roleIR);
  }

  return { graphs, roleIRs };
}

function getManagedHandle(rc: ReagentController, name: string): NativeAgentHandle {
  return rc.getAgent(name) as NativeAgentHandle;
}

function getCustomHandle(rc: ReagentController, name: string): CustomAgentHandle {
  return rc.getAgent(name) as CustomAgentHandle;
}

test("M17: cron review invokes scoring, spawns analyst, and crosses approval boundary", async () => {
  const source = `
message RiskInput {
  assetId: string
}
message AnalystPing {
  assetId: string
}
message AnalystNote {
  note: string
}
message ApprovalRequest {
  assetId: string,
  score: number,
  note: string
}
message ApprovalDecision {
  approved: boolean,
  reason: string
}

protocol ScoreRisk {
  participants:
    coordinator [ts] initiator

  trigger on invoke with RiskInput {
    resolve coordinator = single
  }

  coordinator {
    $self.scoringRuns = ($self.scoringRuns || 0) + 1
    reagent.return({
      assetId: $ctx.input.assetId,
      score: 87,
      severity: "high"
    })
  }
}

protocol ReviewCycle {
  participants:
    coordinator [ts] initiator,
    approver [js],
    analyst [ts] dynamic

  trigger on cron "* * * * *" {
    resolve coordinator = single
    resolve approver = single
  }

  coordinator {
    $self.reviewRuns = ($self.reviewRuns || 0) + 1
    $ctx.assetId = "A-17"
  }

  coordinator invokes ScoreRisk({ assetId: $ctx.assetId }) -> $ctx.scoreCard

  coordinator spawns analyst({
    assetId: $ctx.assetId,
    score: $ctx.scoreCard.score
  }) as analyst persistent -> $ctx.spawnedAnalyst

  coordinator --> analyst: AnalystPing = {
    onSend {
      $ctx.msg.assetId = $ctx.assetId
    }
    onReceive {
      $ctx.assetId = $ctx.msg.assetId
    }
  }

  analyst {
    $self.notesWritten = ($self.notesWritten || 0) + 1
    $ctx.noteText = "investigate:" + $ctx.assetId
  }

  analyst --> coordinator: AnalystNote = {
    onSend {
      $ctx.msg.note = $ctx.noteText
    }
    onReceive {
      $ctx.reviewNote = $ctx.msg.note
    }
  }

  coordinator --> approver: ApprovalRequest = {
    onSend {
      $ctx.msg.assetId = $ctx.assetId
      $ctx.msg.score = $ctx.scoreCard.score
      $ctx.msg.note = $ctx.reviewNote
    }
    onReceive {
      $ctx.reviewPacket = $ctx.msg
    }
  }

  approver {
    $self.approvals = ($self.approvals || 0) + 1
    $ctx.approved = $ctx.reviewPacket.score >= 80
    $ctx.reason = "approve:" + $ctx.reviewPacket.assetId
  }

  approver --> coordinator: ApprovalDecision = {
    onSend {
      $ctx.msg.approved = $ctx.approved
      $ctx.msg.reason = $ctx.reason
    }
    onReceive {
      $self.lastApproved = $ctx.msg.approved
      $self.lastReason = $ctx.msg.reason
      $self.lastScore = $ctx.scoreCard.score
      $self.lastNote = $ctx.reviewNote
      $self.lastSpawnedAnalyst = $ctx.spawnedAnalyst
    }
  }
}

role coordinator [ts] {
  plays ReviewCycle as coordinator
  plays ScoreRisk as coordinator

  init {
    $self.reviewRuns = 0
    $self.scoringRuns = 0
    $self.lastApproved = false
    $self.lastReason = ""
    $self.lastScore = 0
    $self.lastNote = ""
    $self.lastSpawnedAnalyst = ""
  }
}

role approver [js] {
  plays ReviewCycle as approver

  init {
    $self.approvals = 0
  }
}

role analyst [ts] {
  plays ReviewCycle as analyst

  init {
    $self.notesWritten = 0
  }
}
`;

  const { graphs, roleIRs } = compileSource(source);

  const rc = new ReagentController({
    nodeId: "m17-risk-node",
    agentNodes: {
      ts: new NativeAgentNode({ roleToAgent: {} }),
      js: new CustomAgentNode({
        roleToAgent: {},
        agentFactory: () => new ManagedAgentAdapter(),
      }),
    },
    cronIntervalMs: 0,
  });

  rc.registerAgent("CoordinatorAgent", roleIRs.get("coordinator")!, new Map([
    ["ReviewCycle.coordinator", graphs.get("ReviewCycle.coordinator")!],
    ["ScoreRisk.coordinator", graphs.get("ScoreRisk.coordinator")!],
  ]));
  rc.registerAgent("ApproverAgent", roleIRs.get("approver")!, new Map([
    ["ReviewCycle.approver", graphs.get("ReviewCycle.approver")!],
  ]));
  rc.deployAgentTemplate("AnalystTemplate", roleIRs.get("analyst")!, new Map([
    ["ReviewCycle.analyst", graphs.get("ReviewCycle.analyst")!],
  ]));

  try {
    await rc.start();

    rc.cronAgent.tick(new Date("2026-03-12T11:00:00Z"));

    const coordinator = getManagedHandle(rc, "CoordinatorAgent");
    const approver = getCustomHandle(rc, "ApproverAgent");

    await Promise.all([
      coordinator.waitForCompletion(1, 5000),
      approver.waitForCompletion(1, 5000),
    ]);

    const coordinatorSelf = coordinator.getSelf();
    const approverSelf = approver.getSelf();
    const spawnedAnalystName = coordinatorSelf.lastSpawnedAnalyst as string;

    assert.equal(coordinatorSelf.reviewRuns, 1);
    assert.equal(coordinatorSelf.scoringRuns, 1);
    assert.equal(coordinatorSelf.lastApproved, true);
    assert.equal(coordinatorSelf.lastReason, "approve:A-17");
    assert.equal(coordinatorSelf.lastScore, 87);
    assert.equal(coordinatorSelf.lastNote, "investigate:A-17");
    assert.ok(spawnedAnalystName.startsWith("analyst_"));

    assert.equal(approverSelf.approvals, 1);

    const analystHandle = getManagedHandle(rc, spawnedAnalystName);
    assert.ok(analystHandle, "spawned analyst should remain available because the spawn is persistent");
    await analystHandle.waitForCompletion(1, 5000);
    assert.equal(analystHandle.getSelf().notesWritten, 1);
  } finally {
    await rc.stop().catch(() => {});
  }
});
