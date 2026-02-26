/**
 * panelState.ts — Formal state machine for the Protocol View panel.
 *
 * Five modes: idle, source, deployed, debug, replay.
 * Each mode has well-defined context artifacts and allowed transitions.
 */

import type { SequenceDiagramData } from './renderers/sequenceDiagram';
import type { StateMachineDiagramData } from './renderers/stateMachineDiagram';

// ── Types shared with the old CompiledData ──────────────────────────

export interface MessageFieldSchema {
  name: string;
  type: string;
  optional: boolean;
  element?: string;
  fields?: MessageFieldSchema[];
}

export interface CompiledData {
  protocolName: string;
  version?: string;
  sequenceDiagram: SequenceDiagramData;
  stateMachines: Map<string, StateMachineDiagramData>;
  sourceFile: string;
  sourceMap: Map<string, number>;
  roles: string[];
  inputMessageSchema: MessageFieldSchema[] | null;
  inputMessageName: string | null;
  /**
   * Maps any runtime stateId → the diagram element's stateId.
   * The sequence diagram only shows stateIds from the initiator's IR graph,
   * but the runtime reports stateIds from all roles. This map links
   * e.g. buyer's receive stateId to the diagram's send stateId for the same message.
   */
  stateIdAlias: Map<string, string>;
}

export interface AgentInfo {
  name: string;
  role: string;
  node: string;
}

// ── Trace entry (from RAP events) ───────────────────────────────────

export interface TraceEntry {
  kind: string;
  stateId?: string;
  agentName?: string;
  timestamp: number;
  detail?: Record<string, unknown>;
}

// ── Error info ──────────────────────────────────────────────────────

export interface DebugError {
  stateId: string;
  agentName: string;
  message: string;
}

// ── Panel Mode ──────────────────────────────────────────────────────

export type PanelMode = 'idle' | 'source' | 'deployed' | 'debug' | 'replay';
export type ViewKind = 'sequence' | 'statemachine';

// ── Per-mode context objects ────────────────────────────────────────

export interface IdleContext {
  mode: 'idle';
}

export interface SourceContext {
  mode: 'source';
  compiledData: CompiledData;
  breakpoints: Set<string>;
}

export interface DeployedContext {
  mode: 'deployed';
  deployedIR: Record<string, any>;
  deployedVersion: string;
  protocolName: string;
  compiledData?: CompiledData;  // if local source found
}

export interface DebugContext {
  mode: 'debug';
  origin: 'source' | 'deployed';
  sessionId: string;
  sessionType: 'local' | 'cluster';
  compiledData: CompiledData;
  activeStateId: string | null;
  visitedStates: Set<string>;
  breakpoints: Set<string>;
  trace: TraceEntry[];
  error: DebugError | null;
}

export interface ReplayContext {
  mode: 'replay';
  origin: 'source' | 'deployed';
  compiledData: CompiledData;
  visitedStates: Set<string>;
  trace: TraceEntry[];
  finalState: 'completed' | 'failed' | 'stopped';
  error: DebugError | null;
  replayPosition: number;
}

export type ModeContext =
  | IdleContext
  | SourceContext
  | DeployedContext
  | DebugContext
  | ReplayContext;

// ── Full panel state ────────────────────────────────────────────────

export interface PanelState {
  context: ModeContext;
  viewKind: ViewKind;
  selectedRole: string;
  cluster: { connected: boolean; agents: AgentInfo[] } | null;
}

// ── Transition events ───────────────────────────────────────────────

export type PanelEvent =
  | { type: 'openRgFile'; compiledData: CompiledData }
  | { type: 'rgFileUpdated'; compiledData: CompiledData }
  | { type: 'rgFileClosed' }
  | { type: 'clusterConnected' }
  | { type: 'clusterDisconnected' }
  | { type: 'clusterProtocolSelected'; ir: Record<string, any>; version: string; protocolName: string }
  | { type: 'switchToSource' }
  | { type: 'debugStart'; sessionId: string; sessionType: 'local' | 'cluster'; compiledData: CompiledData; breakpoints: Set<string> }
  | { type: 'debugStopped'; stateId: string; stateKind?: string; agentName?: string; reason?: string }
  | { type: 'debugError'; error: DebugError }
  | { type: 'debugTraceEvent'; entry: TraceEntry }
  | { type: 'debugSessionEnded'; finalState: 'completed' | 'failed' | 'stopped' }
  | { type: 'userStoppedDebug' }
  | { type: 'closeReplay' }
  | { type: 'replaySeek'; position: number };

// ── Transition function ─────────────────────────────────────────────

export function transition(state: PanelState, event: PanelEvent): PanelState {
  const ctx = state.context;

  switch (event.type) {

    // ── Source file lifecycle ──────────────────────────────────────

    case 'openRgFile': {
      if (ctx.mode === 'debug') return state; // don't interrupt debug
      const breakpoints = ctx.mode === 'source' ? ctx.breakpoints : new Set<string>();
      return {
        ...state,
        context: {
          mode: 'source',
          compiledData: event.compiledData,
          breakpoints,
        },
        selectedRole: pickRole(state.selectedRole, event.compiledData.roles),
      };
    }

    case 'rgFileUpdated': {
      if (ctx.mode === 'source') {
        return {
          ...state,
          context: { ...ctx, compiledData: event.compiledData },
          selectedRole: pickRole(state.selectedRole, event.compiledData.roles),
        };
      }
      // In other modes, ignore source updates (debug/replay freeze the diagram)
      return state;
    }

    case 'rgFileClosed': {
      if (ctx.mode === 'source') {
        return { ...state, context: { mode: 'idle' } };
      }
      return state;
    }

    // ── Cluster lifecycle ─────────────────────────────────────────

    case 'clusterConnected':
      return { ...state, cluster: { connected: true, agents: state.cluster?.agents ?? [] } };

    case 'clusterDisconnected': {
      if (ctx.mode === 'deployed') {
        if (ctx.compiledData) {
          return {
            ...state,
            context: { mode: 'source', compiledData: ctx.compiledData, breakpoints: new Set() },
            cluster: null,
          };
        }
        return { ...state, context: { mode: 'idle' }, cluster: null };
      }
      return { ...state, cluster: null };
    }

    case 'clusterProtocolSelected': {
      return {
        ...state,
        context: {
          mode: 'deployed',
          deployedIR: event.ir,
          deployedVersion: event.version,
          protocolName: event.protocolName,
          compiledData: ctx.mode === 'source' ? ctx.compiledData : undefined,
        },
      };
    }

    case 'switchToSource': {
      if (ctx.mode === 'deployed' && ctx.compiledData) {
        return {
          ...state,
          context: { mode: 'source', compiledData: ctx.compiledData, breakpoints: new Set() },
        };
      }
      if (ctx.mode === 'replay') {
        return {
          ...state,
          context: { mode: 'source', compiledData: ctx.compiledData, breakpoints: new Set() },
        };
      }
      return state;
    }

    // ── Debug lifecycle ───────────────────────────────────────────

    case 'debugStart': {
      const origin: 'source' | 'deployed' =
        ctx.mode === 'deployed' ? 'deployed' : 'source';
      return {
        ...state,
        context: {
          mode: 'debug',
          origin,
          sessionId: event.sessionId,
          sessionType: event.sessionType,
          compiledData: event.compiledData,
          activeStateId: null,
          visitedStates: new Set(),
          breakpoints: event.breakpoints,
          trace: [],
          error: null,
        },
      };
    }

    case 'debugStopped': {
      if (ctx.mode !== 'debug') return state;
      const visited = new Set(ctx.visitedStates);
      visited.add(event.stateId);
      const entry: TraceEntry = {
        kind: 'Stopped',
        stateId: event.stateId,
        agentName: event.agentName,
        timestamp: Date.now(),
        detail: { stateKind: event.stateKind, reason: event.reason },
      };
      return {
        ...state,
        context: {
          ...ctx,
          activeStateId: event.stateId,
          visitedStates: visited,
          trace: [...ctx.trace, entry],
        },
      };
    }

    case 'debugError': {
      if (ctx.mode !== 'debug') return state;
      return {
        ...state,
        context: { ...ctx, error: event.error },
      };
    }

    case 'debugTraceEvent': {
      if (ctx.mode !== 'debug') return state;
      return {
        ...state,
        context: {
          ...ctx,
          trace: [...ctx.trace, event.entry],
        },
      };
    }

    case 'debugSessionEnded': {
      if (ctx.mode !== 'debug') return state;
      const stoppedCount = ctx.trace.filter(e => e.kind === 'Stopped').length;
      return {
        ...state,
        context: {
          mode: 'replay',
          origin: ctx.origin,
          compiledData: ctx.compiledData,
          visitedStates: ctx.visitedStates,
          trace: ctx.trace,
          finalState: event.finalState,
          error: ctx.error,
          replayPosition: Math.max(0, stoppedCount - 1),
        },
      };
    }

    case 'userStoppedDebug': {
      if (ctx.mode !== 'debug') return state;
      const userStoppedCount = ctx.trace.filter(e => e.kind === 'Stopped').length;
      return {
        ...state,
        context: {
          mode: 'replay',
          origin: ctx.origin,
          compiledData: ctx.compiledData,
          visitedStates: ctx.visitedStates,
          trace: ctx.trace,
          finalState: 'stopped',
          error: ctx.error,
          replayPosition: Math.max(0, userStoppedCount - 1),
        },
      };
    }

    // ── Replay lifecycle ──────────────────────────────────────────

    case 'closeReplay': {
      if (ctx.mode !== 'replay') return state;
      return {
        ...state,
        context: { mode: 'source', compiledData: ctx.compiledData, breakpoints: new Set() },
      };
    }

    case 'replaySeek': {
      if (ctx.mode !== 'replay') return state;
      const stoppedMax = ctx.trace.filter(e => e.kind === 'Stopped').length - 1;
      const pos = Math.max(0, Math.min(event.position, stoppedMax));
      return { ...state, context: { ...ctx, replayPosition: pos } };
    }

    default:
      return state;
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

function pickRole(current: string, available: string[]): string {
  if (available.includes(current)) return current;
  return available[0] ?? '';
}

/** Create the initial panel state */
export function initialPanelState(): PanelState {
  return {
    context: { mode: 'idle' },
    viewKind: 'sequence',
    selectedRole: '',
    cluster: null,
  };
}

/** Get compiled data from any mode that has it */
export function getCompiledData(ctx: ModeContext): CompiledData | null {
  switch (ctx.mode) {
    case 'source': return ctx.compiledData;
    case 'deployed': return ctx.compiledData ?? null;
    case 'debug': return ctx.compiledData;
    case 'replay': return ctx.compiledData;
    default: return null;
  }
}

/**
 * Get debug render options for the current mode.
 * Resolves runtime stateIds to diagram stateIds via the alias map.
 */
export function getDebugRenderOpts(ctx: ModeContext): { activeStateId?: string; visitedStateIds?: Set<string> } | undefined {
  const compiledData = getCompiledData(ctx);
  const alias = compiledData?.stateIdAlias;
  const resolve = (sid: string) => alias?.get(sid) ?? sid;

  if (ctx.mode === 'debug') {
    const resolvedVisited = new Set<string>();
    for (const sid of ctx.visitedStates) resolvedVisited.add(resolve(sid));
    return {
      activeStateId: ctx.activeStateId ? resolve(ctx.activeStateId) : undefined,
      visitedStateIds: resolvedVisited,
    };
  }
  if (ctx.mode === 'replay') {
    // replayPosition is an index into stopped events only
    const allStopped = ctx.trace.filter(e => e.kind === 'Stopped' && e.stateId);
    const visibleStopped = allStopped.slice(0, ctx.replayPosition + 1);
    const visited = new Set(visibleStopped.map(e => resolve(e.stateId!)));
    const lastStopped = visibleStopped[visibleStopped.length - 1];
    return {
      activeStateId: lastStopped?.stateId ? resolve(lastStopped.stateId) : undefined,
      visitedStateIds: visited,
    };
  }
  return undefined;
}
