/**
 * M16 E2E: TS-first cross-mode orchestration.
 *
 * One protocol instance spans:
 * - managed initiator (`ManagedBehaviorFactory`)
 * - custom worker (`CustomBehaviorFactory` mounted on the `js` backend slot)
 * - gate-backed approver implemented through `GateSession` + `GateTransport`
 *   and mounted on the `kt` backend slot
 *
 * This is intentionally cross-mode first.
 * Whole-agent dispatch to `Role[py]` is gated on the future Rust RC with
 * PyO3 / equivalent host bindings; see `docs/future/retire-python-runtime.md`.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import { ReagentController } from "../../src/controller/reagent-controller.js";
import { ManagedBehaviorFactory } from "../../src/nodes/managed/managed-behavior-factory.js";
import { CustomBehaviorFactory } from "../../src/nodes/custom-behavior-factory.js";
import { ManagedAgentBehavior } from "../../src/nodes/managed/managed-behavior.js";
import type { AgentBehavior } from "../../src/contracts/agent-behavior.js";
import type { AgentResponse, ProtocolEvent } from "../../src/core/protocol-engine.js";
import { GateSession } from "../../src/nodes/gate/gate-session.js";
import type { GateTransport } from "../../src/nodes/gate/gate-transport.js";
import { compileSource } from "../support/compile-fixtures.js";
import { getHandle as getManagedHandle } from "../support/runtime-fixtures.js";

class LoopbackGateTransport implements GateTransport {
  sent: ProtocolEvent[] = [];
  private responseHandler: ((response: AgentResponse) => void) | null = null;

  constructor(private readonly externalAgent: ManagedAgentBehavior) {}

  send(event: ProtocolEvent): void {
    this.sent.push(event);
    queueMicrotask(async () => {
      try {
        const response = await this.externalAgent.handle(event);
        this.responseHandler?.(response);
      } catch (err) {
        this.responseHandler?.({
          type: "error_thrown",
          error: err instanceof Error ? err : new Error(String(err)),
        });
      }
    });
  }

  onResponse(handler: (response: AgentResponse) => void): void {
    this.responseHandler = handler;
  }

  close(): void {}
}

class GateBackedAgent implements AgentBehavior {
  private transport: LoopbackGateTransport;
  private session: GateSession | null = null;

  constructor() {
    this.transport = new LoopbackGateTransport(new ManagedAgentBehavior());
  }

  async handle(event: ProtocolEvent): Promise<AgentResponse> {
    if (!this.session || this.session.getStatus() === "completed" || this.session.getStatus() === "error") {
      this.session = new GateSession({
        sessionId: `gate-session-${Date.now()}`,
        agentName: "gate-backed-agent",
        protocolName: "CrossModeApproval",
        transport: this.transport,
      });
    }
    return await this.session.sendAndWait(event, 5000);
  }

  getSentEvents(): ProtocolEvent[] {
    return this.transport.sent;
  }
}

const getCustomHandle = getManagedHandle;

test("M16: one flow spans managed, custom, and gate-backed agents", async () => {
  const source = `
message StartWork {
  task: string
}
message WorkResult {
  summary: string
}
message ApprovalRequest {
  summary: string
}
message ApprovalDecision {
  approved: boolean,
  reason: string
}

protocol CrossModeApproval {
  participants:
    manager [ts] initiator,
    worker [js],
    approver [kt]

  trigger on invoke with StartWork {
    resolve manager = single
    resolve worker = single
    resolve approver = single
  }

  manager --> worker: StartWork = {
    onSend {
      $ctx.msg.task = $ctx.input.task
    }
    onReceive {
      $ctx.task = $ctx.msg.task
    }
  }

  worker {
    $self.jobs = ($self.jobs || 0) + 1
    $ctx.summary = "built:" + $ctx.task
  }

  worker --> manager: WorkResult = {
    onSend {
      $ctx.msg.summary = $ctx.summary
    }
    onReceive {
      $self.lastWork = $ctx.msg.summary
      $ctx.summary = $ctx.msg.summary
    }
  }

  manager --> approver: ApprovalRequest = {
    onSend {
      $ctx.msg.summary = $ctx.summary
    }
    onReceive {
      $ctx.summary = $ctx.msg.summary
    }
  }

  approver {
    $self.approvals = ($self.approvals || 0) + 1
    $ctx.approved = true
    $ctx.reason = "ok:" + $ctx.summary
  }

  approver --> manager: ApprovalDecision = {
    onSend {
      $ctx.msg.approved = $ctx.approved
      $ctx.msg.reason = $ctx.reason
    }
    onReceive {
      if ($ctx.msg.approved) {
        $self.finalStatus = "approved:" + $ctx.summary
      } else {
        $self.finalStatus = "rejected"
      }
      $self.approvalReason = $ctx.msg.reason
    }
  }
}

role manager [ts] {
  plays CrossModeApproval as manager

  init {
    $self.lastWork = ""
    $self.finalStatus = ""
    $self.approvalReason = ""
  }
}

role worker [js] {
  plays CrossModeApproval as worker

  init {
    $self.jobs = 0
  }
}

role approver [kt] {
  plays CrossModeApproval as approver

  init {
    $self.approvals = 0
  }
}
`;

  const { graphs, roleIRs } = compileSource(source);

  const managedFactory = new ManagedBehaviorFactory();
  const customFactory = new CustomBehaviorFactory({
    behaviorFactory: () => new ManagedAgentBehavior(),
  });
  const gateAgents = new Map<string, GateBackedAgent>();
  const gateFactory = new CustomBehaviorFactory({
    behaviorFactory: (agentName) => {
      const agent = new GateBackedAgent();
      gateAgents.set(agentName, agent);
      return agent;
    },
  });

  const rc = new ReagentController({
    nodeId: "m16-cross-mode-node",
    behaviorFactories: {
      ts: managedFactory,
      js: customFactory,
      kt: gateFactory,
    },
  });

  rc.registerAgent("ManagerAgent", roleIRs.get("manager")!, new Map([
    ["CrossModeApproval.manager", graphs.get("CrossModeApproval.manager")!],
  ]));
  rc.registerAgent("WorkerAgent", roleIRs.get("worker")!, new Map([
    ["CrossModeApproval.worker", graphs.get("CrossModeApproval.worker")!],
  ]));
  rc.registerAgent("ApproverAgent", roleIRs.get("approver")!, new Map([
    ["CrossModeApproval.approver", graphs.get("CrossModeApproval.approver")!],
  ]));

  try {
    await rc.start();

    rc.triggerProtocol("ManagerAgent", {
      instanceId: randomUUID(),
      protocolName: "CrossModeApproval",
      input: { task: "draft-review" },
      roleToAgent: {
        "CrossModeApproval.manager": "ManagerAgent",
        "CrossModeApproval.worker": "WorkerAgent",
        "CrossModeApproval.approver": "ApproverAgent",
      },
    });

    const manager = getManagedHandle(rc, "ManagerAgent");
    const worker = getCustomHandle(rc, "WorkerAgent");
    const approver = getCustomHandle(rc, "ApproverAgent");

    await Promise.all([
      manager.waitForCompletion(1, 5000),
      worker.waitForCompletion(1, 5000),
      approver.waitForCompletion(1, 5000),
    ]);

    const managerSelf = manager.getSelf();
    const workerSelf = worker.getSelf();
    const approverSelf = approver.getSelf();

    assert.equal(managerSelf.lastWork, "built:draft-review");
    assert.equal(managerSelf.finalStatus, "approved:built:draft-review");
    assert.equal(managerSelf.approvalReason, "ok:built:draft-review");

    assert.equal(workerSelf.jobs, 1);
    assert.equal(approverSelf.approvals, 1);

    const gateAgent = gateAgents.get("ApproverAgent");
    assert.ok(gateAgent, "Gate-backed approver agent should exist");
    assert.ok(
      gateAgent.getSentEvents().some((event) => event.type === "action"),
      "Gate-backed path should receive action events through GateSession transport",
    );
  } finally {
    await rc.stop().catch(() => {});
  }
});
