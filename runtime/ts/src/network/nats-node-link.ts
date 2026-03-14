/**
 * NatsNodeLink — NATS-backed NodeLink for inter-node envelope transport.
 *
 * Uses a single NATS subject per node: `reagent.node.{nodeId}`.
 * Outbound envelopes are published to `reagent.node.{remoteNodeId}`.
 * Inbound envelopes arrive on `reagent.node.{localNodeId}`.
 *
 * NATS is treated as a byte pipe — no per-agent subjects, no topic matching.
 * All routing intelligence stays in the RC.
 */

import {
  connect,
  type NatsConnection,
  type Subscription,
  StringCodec,
} from "nats";
import type { MessageEnvelope } from "../contracts/types.js";
import type { NodeLink } from "../contracts/transport.js";

const sc = StringCodec();

export interface NatsNodeLinkConfig {
  localNodeId: string;
  remoteNodeId: string;
  natsUrl: string;
}

export class NatsNodeLink implements NodeLink {
  readonly remoteNodeId: string;
  private localNodeId: string;
  private natsUrl: string;
  private nc: NatsConnection | null = null;
  private sub: Subscription | null = null;
  private handler: ((envelope: MessageEnvelope) => void) | null = null;

  constructor(config: NatsNodeLinkConfig) {
    this.localNodeId = config.localNodeId;
    this.remoteNodeId = config.remoteNodeId;
    this.natsUrl = config.natsUrl;
  }

  async connect(): Promise<void> {
    this.nc = await connect({
      servers: this.natsUrl,
      timeout: 2_000,
      maxReconnectAttempts: 0,
      waitOnFirstConnect: false,
    });
    const inboundSubject = `reagent.node.${this.localNodeId}`;
    this.sub = this.nc.subscribe(inboundSubject);
    (async () => {
      for await (const msg of this.sub!) {
        try {
          const envelope = JSON.parse(sc.decode(msg.data)) as MessageEnvelope;
          this.handler?.(envelope);
        } catch {
          // ignore malformed messages
        }
      }
    })();
  }

  async close(): Promise<void> {
    this.sub?.unsubscribe();
    this.sub = null;
    if (this.nc && !this.nc.isClosed()) {
      try {
        await this.nc.drain();
      } catch {
        // connection may already be closing
      }
    }
    this.nc = null;
  }

  send(envelope: MessageEnvelope): void {
    if (!this.nc) throw new Error(`NatsNodeLink to ${this.remoteNodeId} not connected`);
    const outboundSubject = `reagent.node.${this.remoteNodeId}`;
    this.nc.publish(outboundSubject, sc.encode(JSON.stringify(envelope)));
  }

  onEnvelope(handler: (envelope: MessageEnvelope) => void): void {
    this.handler = handler;
  }
}
