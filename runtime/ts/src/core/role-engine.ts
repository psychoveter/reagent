/**
 * RoleEngine — R1 ontology.
 *
 * Unified passive FSM that drives one local role execution. Extends the
 * existing ProtocolEngine with first-class message dispatch (inbox + resolvers)
 * and a RoleRunIdentity.
 *
 * Key difference from old ProtocolEngine: dispatchMessage() is a first-class
 * method — no monkey-patching of private inbox fields.
 */

import type { IRGraph, IRState, IRTransition, MessageEnvelope } from "../contracts/types.js";
import { ProtocolEngine, durationToMs } from "./protocol-engine.js";
import type { ProtocolEvent, AgentResponse, EngineStatus } from "./protocol-engine.js";
import type { RoleRunIdentity } from "../contracts/protocol-run.js";

// Re-export for convenience
export { durationToMs } from "./protocol-engine.js";
export type { ProtocolEvent, AgentResponse, EngineStatus } from "./protocol-engine.js";

// ── RoleEngineInterface ──────────────────────────────────────────────

export interface RoleEngineInterface {
  readonly identity: RoleRunIdentity;

  getStatus(): EngineStatus;
  getCurrentStateId(): string;
  getGraph(): IRGraph;
  getStateMap(): Map<string, IRState>;
  getTransitionsFrom(): Map<string, IRTransition[]>;

  get ctx(): Record<string, unknown>;
  set ctx(val: Record<string, unknown>);
  get selfRef(): Record<string, unknown>;

  dispatchMessage(env: MessageEnvelope): void;
  waitForMessage(messageName: string): Promise<MessageEnvelope>;
  consumeBufferedMessage(messageName: string): MessageEnvelope | undefined;

  getReturnValue(): { value: unknown; has: boolean };
  setReturnValue(value: unknown): void;

  evalExpr(expr: string): unknown;
  expressionVarsAreDefined(expr: string): boolean;

  followDefault(): string;
  findFirstReceiveInBranch(stateId: string): string | null;
  findJoinForFork(forkId: string): string | null;
  findLoopExit(fromStateId: string): string | null;
  findAlternateErrorReceive(currentRecvState: IRState): { stateId: string; messageName: string } | null;

  setCurrentState(stateId: string): void;
  setStatus(status: EngineStatus): void;

  pushCatchTarget(target: string): void;
  popCatchTarget(): string | undefined;
  hasCatchTargets(): boolean;
  getCatchTarget(stateId: string): string | undefined;

  assignTarget(target: string, value: unknown): void;
}

// ── RoleEngine implementation ────────────────────────────────────────

export interface RoleEngineConfig {
  instanceId: string;
  protocolName: string;
  agentName: string;
  roleName: string;
  selfRef: Record<string, unknown>;
  input?: Record<string, unknown>;
}

export class RoleEngine extends ProtocolEngine implements RoleEngineInterface {
  readonly identity: RoleRunIdentity;

  private readonly inbox: MessageEnvelope[] = [];
  private readonly resolvers = new Map<string, (env: MessageEnvelope) => void>();

  constructor(graph: IRGraph, config: RoleEngineConfig) {
    super(graph, config);
    this.identity = {
      instanceId: config.instanceId,
      protocolName: config.protocolName,
      roleName: config.roleName,
      agentName: config.agentName,
    };
  }

  getStatus(): EngineStatus {
    return this.status;
  }

  /**
   * Deliver an inbound message to this engine. If a resolver is
   * waiting for this messageName, it fires immediately. Otherwise
   * the message is buffered in the inbox for later consumption.
   */
  dispatchMessage(env: MessageEnvelope): void {
    const resolver = this.resolvers.get(env.messageName);
    if (resolver) {
      this.resolvers.delete(env.messageName);
      resolver(env);
    } else {
      this.inbox.push(env);
    }
  }

  /**
   * Wait for a message with the given name. Checks the inbox first;
   * if not found, returns a promise that resolves when the message arrives.
   */
  waitForMessage(messageName: string): Promise<MessageEnvelope> {
    const idx = this.inbox.findIndex(e => e.messageName === messageName);
    if (idx >= 0) {
      return Promise.resolve(this.inbox.splice(idx, 1)[0]);
    }
    return new Promise<MessageEnvelope>(resolve => {
      this.resolvers.set(messageName, resolve);
    });
  }

  /**
   * Synchronously try to consume a buffered message by name.
   * Returns undefined if not in the inbox.
   */
  consumeBufferedMessage(messageName: string): MessageEnvelope | undefined {
    const idx = this.inbox.findIndex(e => e.messageName === messageName);
    if (idx >= 0) return this.inbox.splice(idx, 1)[0];
    return undefined;
  }
}
