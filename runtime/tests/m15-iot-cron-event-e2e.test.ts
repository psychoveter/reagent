/**
 * M15 E2E: deterministic cron -> emit -> event-triggered follow-up flow.
 *
 * TS-first, single-node, no external infra:
 * - ScheduledPoll starts from a cron trigger
 * - monitor emits an anomaly event after receiving a sensor reading
 * - AnomalyInvestigation starts from that event and updates persistent state
 */

import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { test } from "node:test";

import { ReagentController } from "../ts/src/controller/reagent-controller.js";
import { NativeAgentNode, NativeAgentHandle } from "../ts/src/nodes/native-agent-node.js";
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

function getHandle(rc: ReagentController, name: string): NativeAgentHandle {
  return rc.getAgent(name) as NativeAgentHandle;
}

test("M15: cron trigger emits event that starts follow-up protocol", async () => {
  const source = `
message PollRequest {}
message SensorReading {
  sensorId: string,
  temperature: number
}
message DiagnosisRequest {
  sensorId: string,
  temperature: number,
  historySize: number
}
message DiagnosisResult {
  rootCause: string,
  action: string
}

protocol ScheduledPoll {
  participants:
    monitor [ts] initiator,
    sensor [ts]

  trigger on cron "* * * * *" {
    resolve monitor = single
    resolve sensor = single
  }

  monitor --> sensor: PollRequest = {}

  sensor {
    $ctx.temperature = 91
    $self.reads = ($self.reads || 0) + 1
  }

  sensor --> monitor: SensorReading = {
    onSend {
      $ctx.msg.sensorId = "sensor-1"
      $ctx.msg.temperature = $ctx.temperature
    }
    onReceive {
      $self.polls = ($self.polls || 0) + 1
      $self.history.push({
        sensorId: $ctx.msg.sensorId,
        temperature: $ctx.msg.temperature
      })
      reagent.emit("anomaly.detected", {
        sensorId: $ctx.msg.sensorId,
        temperature: $ctx.msg.temperature,
        historySize: $self.history.length
      })
    }
  }
}

protocol AnomalyInvestigation {
  participants:
    monitor [ts] initiator,
    diagnostics [ts]

  trigger on event "anomaly.detected" with DiagnosisRequest {
    resolve monitor = single
    resolve diagnostics = single
  }

  monitor --> diagnostics: DiagnosisRequest = {
    onSend {
      $ctx.msg.sensorId = $ctx.input.sensorId
      $ctx.msg.temperature = $ctx.input.temperature
      $ctx.msg.historySize = $ctx.input.historySize
    }
    onReceive {
      $ctx.alert = $ctx.msg
    }
  }

  diagnostics {
    $self.diagnoses = ($self.diagnoses || 0) + 1
    $ctx.rootCause = "overheat"
    $ctx.action = "inspect:" + $ctx.alert.sensorId
  }

  diagnostics --> monitor: DiagnosisResult = {
    onSend {
      $ctx.msg.rootCause = $ctx.rootCause
      $ctx.msg.action = $ctx.action
    }
    onReceive {
      $self.investigations = ($self.investigations || 0) + 1
      $self.lastDiagnosis = {
        sensorId: $ctx.input.sensorId,
        historySize: $ctx.input.historySize,
        rootCause: $ctx.msg.rootCause,
        action: $ctx.msg.action
      }
    }
  }
}

role monitor [ts] {
  plays ScheduledPoll as monitor
  plays AnomalyInvestigation as monitor

  init {
    $self.history = []
    $self.polls = 0
    $self.investigations = 0
    $self.lastDiagnosis = null
  }
}

role sensor [ts] {
  plays ScheduledPoll as sensor

  init {
    $self.reads = 0
  }
}

role diagnostics [ts] {
  plays AnomalyInvestigation as diagnostics

  init {
    $self.diagnoses = 0
  }
}
`;

  const { graphs, roleIRs } = compileSource(source);
  const agentNode = new NativeAgentNode({ roleToAgent: {} });
  const rc = new ReagentController({
    nodeId: "m15-iot-node",
    agentNode,
    cronIntervalMs: 0,
  });

  rc.registerAgent("MonitorAgent", roleIRs.get("monitor")!, new Map([
    ["ScheduledPoll.monitor", graphs.get("ScheduledPoll.monitor")!],
    ["AnomalyInvestigation.monitor", graphs.get("AnomalyInvestigation.monitor")!],
  ]));
  rc.registerAgent("SensorAgent", roleIRs.get("sensor")!, new Map([
    ["ScheduledPoll.sensor", graphs.get("ScheduledPoll.sensor")!],
  ]));
  rc.registerAgent("DiagnosticsAgent", roleIRs.get("diagnostics")!, new Map([
    ["AnomalyInvestigation.diagnostics", graphs.get("AnomalyInvestigation.diagnostics")!],
  ]));

  try {
    await rc.start();

    // Fire exactly one cron tick deterministically.
    rc.cronAgent.tick(new Date("2026-03-12T10:15:00Z"));

    const monitor = getHandle(rc, "MonitorAgent");
    const sensor = getHandle(rc, "SensorAgent");
    const diagnostics = getHandle(rc, "DiagnosticsAgent");

    await Promise.all([
      monitor.waitForCompletion(2, 5000),
      sensor.waitForCompletion(1, 5000),
      diagnostics.waitForCompletion(1, 5000),
    ]);

    const monitorSelf = monitor.getSelf();
    const sensorSelf = sensor.getSelf();
    const diagnosticsSelf = diagnostics.getSelf();

    assert.equal(monitorSelf.polls, 1);
    assert.equal(monitorSelf.investigations, 1);
    assert.equal(Array.isArray(monitorSelf.history), true);
    assert.equal(monitorSelf.history.length, 1);
    assert.deepEqual(monitorSelf.lastDiagnosis, {
      sensorId: "sensor-1",
      historySize: 1,
      rootCause: "overheat",
      action: "inspect:sensor-1",
    });

    assert.equal(sensorSelf.reads, 1);
    assert.equal(diagnosticsSelf.diagnoses, 1);

    // Ensure both protocols really ran by checking completion traces.
    const completedProtocols = [...monitor.getInstances().values()]
      .filter((instance) => instance.getStatus() === "completed")
      .map((instance) => instance.protocolName)
      .sort();
    assert.deepEqual(completedProtocols, ["AnomalyInvestigation", "ScheduledPoll"]);
  } finally {
    await rc.stop().catch(() => {});
  }
});
