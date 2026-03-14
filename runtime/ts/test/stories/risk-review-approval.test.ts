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

import { ReagentController } from "../../src/controller/reagent-controller.js";
import { ManagedBehaviorFactory } from "../../src/nodes/managed-behavior-factory.js";
import { CustomBehaviorFactory } from "../../src/nodes/custom-behavior-factory.js";
import { ManagedAgentBehavior } from "../../src/core/agent-interface.js";
import { compileSource } from "../support/compile-fixtures.js";
import { getHandle as getManagedHandle } from "../support/runtime-fixtures.js";

const getCustomHandle = getManagedHandle;

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
    behaviorFactories: {
      ts: new ManagedBehaviorFactory(),
      js: new CustomBehaviorFactory({
        behaviorFactory: () => new ManagedAgentBehavior(),
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
