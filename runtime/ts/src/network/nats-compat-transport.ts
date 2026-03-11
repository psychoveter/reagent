/**
 * NatsCompatTransport — bridges NatsTransport to the ReagentTransport interface.
 *
 * Temporary shim that allows the existing NATS-based E2E tests to run
 * with the refactored AgentRunner/ProtocolInstance that now expect
 * ReagentTransport. Will be retired when all tests move to
 * ReagentController + loopback/InMemoryNodeLink.
 */

import type { MessageEnvelope } from "../contracts/types.js";
import { msgSubject, msgSubscribePattern, triggerSubject, traceSubject } from "../contracts/types.js";
import type { ReagentTransport, AgentRef, NodeRef } from "../contracts/transport.js";
import { NatsTransport } from "./nats-transport.js";

export class NatsCompatTransport implements ReagentTransport {
  readonly agentName: string;
  private nats: NatsTransport;
  private messageHandler: ((envelope: MessageEnvelope) => void) | null = null;

  constructor(agentName: string, nats: NatsTransport) {
    this.agentName = agentName;
    this.nats = nats;
  }

  ref(targetAgent: string): AgentRef {
    return new NatsCompatAgentRef(targetAgent, this.nats, this);
  }

  onMessage(handler: (envelope: MessageEnvelope) => void): void {
    this.messageHandler = handler;
    this.nats.subscribe(
      msgSubscribePattern(this.agentName),
      (data, _subject) => {
        handler(data as MessageEnvelope);
      },
    );
  }

  /** Expose the underlying NatsTransport for trigger subscriptions and trace publishing. */
  getNats(): NatsTransport {
    return this.nats;
  }

  /** Subscribe to triggers via NATS (used by test harness). */
  subscribeTriggers(handler: (data: unknown) => void): void {
    this.nats.subscribe(triggerSubject(this.agentName), handler);
  }

  /** Publish trace events via NATS (backward compat). */
  publishTrace(instanceId: string, event: unknown): void {
    this.nats.publish(traceSubject(instanceId), event);
  }
}

/** Loopback-aware NodeRef for the NATS compat layer. */
class NatsCompatNodeRef implements NodeRef {
  readonly nodeId = "nats-compat";

  constructor(private nats: NatsTransport) {}

  send(envelope: MessageEnvelope): void {
    const subject = msgSubject(envelope.instanceId, envelope.to.agent, envelope.messageName);
    this.nats.publish(subject, envelope);
  }
}

/** AgentRef backed by NatsTransport — sends envelopes via NATS subjects. */
class NatsCompatAgentRef implements AgentRef {
  readonly agentName: string;
  readonly nodeRef: NodeRef;
  private nats: NatsTransport;
  private transport: NatsCompatTransport;

  constructor(agentName: string, nats: NatsTransport, transport: NatsCompatTransport) {
    this.agentName = agentName;
    this.nats = nats;
    this.transport = transport;
    this.nodeRef = new NatsCompatNodeRef(nats);
  }

  send(_messageName: string, _payload: Record<string, unknown>): void {
    throw new Error("NatsCompatAgentRef.send() convenience not implemented — use sendEnvelope()");
  }

  sendEnvelope(envelope: MessageEnvelope): void {
    const subject = msgSubject(envelope.instanceId, this.agentName, envelope.messageName);
    this.nats.publish(subject, envelope);
  }
}
