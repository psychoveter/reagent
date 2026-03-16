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

import { ReagentController } from "../../src/controller/reagent-controller.js";
import { ManagedBehaviorFactory } from "../../src/nodes/managed/managed-behavior-factory.js";
import { compileSource } from "../support/compile-fixtures.js";
import { getHandle } from "../support/runtime-fixtures.js";

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
  const behaviorFactory = new ManagedBehaviorFactory();
  const rc = new ReagentController({
    nodeId: "m15-iot-node",
    behaviorFactory,
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
      .map((instance) => {
        const started = instance.getTraces().find((trace) => trace.kind === "ProtocolStarted");
        return started?.data?.protocolName;
      })
      .sort();
    assert.deepEqual(completedProtocols, ["AnomalyInvestigation", "ScheduledPoll"]);
  } finally {
    await rc.stop().catch(() => {});
  }
});
