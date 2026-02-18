/**
 * InMemoryNodeLink — in-process envelope pipe for tests and single-process multi-node setups.
 *
 * Creates a pair of linked NodeLinks: what one sends, the other receives.
 * No serialization, no network — direct function call delivery.
 */

import type { MessageEnvelope } from "./types.js";
import type { NodeLink } from "./transport.js";

export class InMemoryNodeLink implements NodeLink {
  readonly remoteNodeId: string;
  private handler: ((envelope: MessageEnvelope) => void) | null = null;
  private peer: InMemoryNodeLink | null = null;
  private connected = false;

  constructor(remoteNodeId: string) {
    this.remoteNodeId = remoteNodeId;
  }

  async connect(): Promise<void> {
    this.connected = true;
  }

  async close(): Promise<void> {
    this.connected = false;
    this.handler = null;
  }

  send(envelope: MessageEnvelope): void {
    if (!this.connected) throw new Error(`InMemoryNodeLink to ${this.remoteNodeId} not connected`);
    // Deliver to the peer's handler (the other end of the pipe)
    this.peer?.handler?.(envelope);
  }

  onEnvelope(handler: (envelope: MessageEnvelope) => void): void {
    this.handler = handler;
  }

  /** @internal Wire the two ends of the pipe together. */
  _setPeer(peer: InMemoryNodeLink): void {
    this.peer = peer;
  }
}

/**
 * Create a bidirectional InMemoryNodeLink pair connecting two nodes.
 * Returns [linkForNodeA, linkForNodeB].
 */
export function createInMemoryLinkPair(
  nodeAId: string,
  nodeBId: string,
): [InMemoryNodeLink, InMemoryNodeLink] {
  const linkA = new InMemoryNodeLink(nodeBId);
  const linkB = new InMemoryNodeLink(nodeAId);
  linkA._setPeer(linkB);
  linkB._setPeer(linkA);
  return [linkA, linkB];
}
