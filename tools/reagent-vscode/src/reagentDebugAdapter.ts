import * as vscode from 'vscode';
import { RapClient } from './rapClient';
import * as fs from 'fs';
import * as path from 'path';

const THREAD_ID = 1;

interface LaunchConfig extends vscode.DebugConfiguration {
  rgFile: string;
  rosHost?: string;
  rosPort?: number;
}

interface SourceMapEntry {
  stateId: string;
  protocolName: string;
  role: string;
  file: string;
  line: number;
  column: number;
}

/**
 * Inline debug adapter that speaks DAP to VS Code and RAP to the ROS.
 */
class ReagentDebugSession implements vscode.DebugAdapter {
  private sendMessage: vscode.EventEmitter<vscode.DebugProtocolMessage> = new vscode.EventEmitter();
  readonly onDidSendMessage: vscode.Event<vscode.DebugProtocolMessage> = this.sendMessage.event;

  private rap: RapClient | null = null;
  private sessionId: string | null = null;
  private sourceMap: SourceMapEntry[] = [];
  private rgFilePath = '';
  private disposables: vscode.Disposable[] = [];
  private paused = false;
  private stoppedReason = '';
  private stoppedDetail: Record<string, unknown> = {};
  private seq = 0;

  handleMessage(message: vscode.DebugProtocolMessage): void {
    const msg = message as { type: string; command?: string; seq: number; arguments?: Record<string, unknown> };
    if (msg.type === 'request') {
      this.handleRequest(msg.command!, msg.seq, msg.arguments || {});
    }
  }

  private async handleRequest(command: string, reqSeq: number, args: Record<string, unknown>): Promise<void> {
    try {
      switch (command) {
        case 'initialize':
          this.sendResponse(reqSeq, command, {
            supportsConfigurationDoneRequest: true,
            supportsEvaluateForHovers: false,
            supportsStepBack: false,
            supportsSetVariable: false,
            supportsRestartFrame: false,
            supportsGotoTargetsRequest: false,
            supportsStepInTargetsRequest: false,
            supportsCompletionsRequest: false,
            supportsModulesRequest: false,
            supportsExceptionOptions: false,
            supportTerminateDebuggee: true,
          });
          this.sendEvent('initialized', {});
          break;

        case 'launch':
          await this.handleLaunch(reqSeq, args as unknown as LaunchConfig);
          break;

        case 'configurationDone':
          this.sendResponse(reqSeq, command);
          break;

        case 'threads':
          this.sendResponse(reqSeq, command, {
            threads: [{ id: THREAD_ID, name: 'Reagent Protocol' }],
          });
          break;

        case 'stackTrace':
          this.handleStackTrace(reqSeq);
          break;

        case 'scopes':
          this.handleScopes(reqSeq, args);
          break;

        case 'variables':
          await this.handleVariables(reqSeq, args);
          break;

        case 'setBreakpoints':
          await this.handleSetBreakpoints(reqSeq, args);
          break;

        case 'continue':
          await this.handleContinue(reqSeq);
          break;

        case 'next':
          await this.handleStep(reqSeq, 'stepState');
          break;

        case 'stepIn':
          await this.handleStep(reqSeq, 'stepState');
          break;

        case 'stepOut':
          await this.handleStep(reqSeq, 'stepOver');
          break;

        case 'pause':
          this.sendResponse(reqSeq, command);
          break;

        case 'disconnect':
          this.handleDisconnect(reqSeq);
          break;

        default:
          this.sendResponse(reqSeq, command);
          break;
      }
    } catch (err) {
      this.sendErrorResponse(reqSeq, command, String(err));
    }
  }

  private async handleLaunch(reqSeq: number, config: LaunchConfig): Promise<void> {
    const rosHost = config.rosHost || '127.0.0.1';
    const rosPort = config.rosPort || 18789;
    this.rgFilePath = config.rgFile;

    this.rap = new RapClient(`ws://${rosHost}:${rosPort}`);
    try {
      await this.rap.connect();
    } catch (err) {
      this.sendErrorResponse(reqSeq, 'launch', `Cannot connect to ROS at ws://${rosHost}:${rosPort}: ${err}`);
      return;
    }

    // Listen for Stopped events from ROS
    this.disposables.push(this.rap.on('Stopped', (msg) => {
      this.paused = true;
      this.stoppedReason = String(msg.payload?.reason || 'breakpoint');
      this.stoppedDetail = (msg.payload || {}) as Record<string, unknown>;
      this.sendEvent('stopped', {
        reason: 'breakpoint',
        threadId: THREAD_ID,
        description: this.stoppedReason,
        allThreadsStopped: true,
      });
    }));

    // Listen for RunCompleted
    this.disposables.push(this.rap.on('RunCompleted', () => {
      this.sendEvent('terminated', {});
    }));

    // Listen for TraceEvents (emit as output)
    this.disposables.push(this.rap.on('TraceEvent', (msg) => {
      const p = msg.payload || {};
      const kind = p.kind || 'trace';
      const agent = p.agentName || '';
      this.sendEvent('output', {
        category: 'console',
        output: `[${kind}] ${agent}: ${JSON.stringify(p)}\n`,
      });
    }));

    // Read .rg source
    let rgSource: string;
    try {
      rgSource = fs.readFileSync(this.rgFilePath, 'utf-8');
    } catch (err) {
      this.sendErrorResponse(reqSeq, 'launch', `Cannot read ${this.rgFilePath}: ${err}`);
      return;
    }

    // Compile
    const compileResp = await this.rap.request('Compile', { source: rgSource }, 'CompileSuccess', 15000);
    if (compileResp.rap === 'CompileError') {
      this.sendErrorResponse(reqSeq, 'launch', `Compile error: ${JSON.stringify(compileResp.payload)}`);
      return;
    }
    this.sessionId = compileResp.sessionId || (compileResp.payload?.sessionId as string) || 'default';
    this.sourceMap = (compileResp.payload?.sourceMap as SourceMapEntry[]) || [];

    // Start in debug mode
    this.rap.send({
      rap: 'RunStart',
      sessionId: this.sessionId,
      payload: { sessionId: this.sessionId, mode: 'debug' },
    });

    this.sendResponse(reqSeq, 'launch');
  }

  private async handleSetBreakpoints(reqSeq: number, args: Record<string, unknown>): Promise<void> {
    const source = args.source as { path?: string } | undefined;
    const bpArgs = args.breakpoints as Array<{ line: number }> | undefined;
    const breakpoints: Array<{ verified: boolean; line: number; message?: string }> = [];

    if (this.rap?.connected && bpArgs && bpArgs.length > 0) {
      const locations = bpArgs.map(bp => ({
        type: 'sourceLine' as const,
        file: source?.path || this.rgFilePath,
        line: bp.line,
      }));

      this.rap.send({
        rap: 'SetBreakpointsRequest',
        sessionId: this.sessionId || 'default',
        payload: {
          sessionId: this.sessionId || 'default',
          breakpoints: locations,
        },
      });

      for (const bp of bpArgs) {
        const mapped = this.sourceMap.find(e => e.line === bp.line);
        breakpoints.push({
          verified: !!mapped,
          line: bp.line,
          message: mapped ? `→ ${mapped.stateId} (${mapped.protocolName}.${mapped.role})` : 'No IR state at this line',
        });
      }
    } else if (bpArgs) {
      for (const bp of bpArgs) {
        breakpoints.push({ verified: false, line: bp.line });
      }
    }

    this.sendResponse(reqSeq, 'setBreakpoints', { breakpoints });
  }

  private handleStackTrace(reqSeq: number): void {
    const frames: Array<{
      id: number;
      name: string;
      source: { name: string; path: string };
      line: number;
      column: number;
    }> = [];

    if (this.paused) {
      const stateId = this.stoppedDetail.stateId as string | undefined;
      const stateKind = this.stoppedDetail.stateKind as string | undefined;
      const agentName = this.stoppedDetail.agentName as string | undefined;
      const mapped = stateId ? this.sourceMap.find(e => e.stateId === stateId) : undefined;

      frames.push({
        id: 1,
        name: `${agentName || 'agent'} @ ${stateKind || 'state'} (${stateId || '?'})`,
        source: {
          name: path.basename(this.rgFilePath),
          path: this.rgFilePath,
        },
        line: mapped?.line || 1,
        column: mapped?.column || 0,
      });
    }

    this.sendResponse(reqSeq, 'stackTrace', {
      stackFrames: frames,
      totalFrames: frames.length,
    });
  }

  private handleScopes(reqSeq: number, args: Record<string, unknown>): void {
    this.sendResponse(reqSeq, 'scopes', {
      scopes: [
        { name: '$ctx', variablesReference: 100, expensive: false },
        { name: '$self', variablesReference: 200, expensive: false },
        { name: 'Held Messages', variablesReference: 300, expensive: false },
      ],
    });
  }

  private async handleVariables(reqSeq: number, args: Record<string, unknown>): Promise<void> {
    const ref = args.variablesReference as number;
    const variables: Array<{ name: string; value: string; variablesReference: number }> = [];

    if (this.rap?.connected && this.paused) {
      try {
        this.rap.send({
          rap: 'GetState',
          sessionId: this.sessionId || 'default',
          payload: { sessionId: this.sessionId || 'default' },
        });

        // Wait for StateSnapshot
        const snapshot = await new Promise<Record<string, unknown>>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Timeout')), 3000);
          const disposable = this.rap!.on('StateSnapshot', (msg) => {
            clearTimeout(timer);
            disposable.dispose();
            resolve((msg.payload || {}) as Record<string, unknown>);
          });
        });

        if (ref === 100) {
          const ctx = (snapshot.ctx || {}) as Record<string, unknown>;
          for (const [key, value] of Object.entries(ctx)) {
            variables.push({ name: key, value: JSON.stringify(value), variablesReference: 0 });
          }
        } else if (ref === 200) {
          const self = (snapshot.self || {}) as Record<string, unknown>;
          for (const [key, value] of Object.entries(self)) {
            variables.push({ name: key, value: JSON.stringify(value), variablesReference: 0 });
          }
        } else if (ref === 300) {
          const held = (snapshot.heldMessages || []) as Array<{ messageName?: string; from?: string; to?: string }>;
          for (let i = 0; i < held.length; i++) {
            const h = held[i];
            variables.push({
              name: `[${i}]`,
              value: `${h.messageName || '?'} (${h.from} → ${h.to})`,
              variablesReference: 0,
            });
          }
        }
      } catch {
        variables.push({ name: '(error)', value: 'Failed to fetch state', variablesReference: 0 });
      }
    }

    this.sendResponse(reqSeq, 'variables', { variables });
  }

  private async handleContinue(reqSeq: number): Promise<void> {
    if (this.rap?.connected) {
      this.rap.send({
        rap: 'DebugCommand',
        sessionId: this.sessionId || 'default',
        payload: { sessionId: this.sessionId || 'default', command: 'continue' },
      });
    }
    this.paused = false;
    this.sendResponse(reqSeq, 'continue', { allThreadsContinued: true });
  }

  private async handleStep(reqSeq: number, stepType: string): Promise<void> {
    if (this.rap?.connected) {
      this.rap.send({
        rap: 'DebugCommand',
        sessionId: this.sessionId || 'default',
        payload: { sessionId: this.sessionId || 'default', command: stepType },
      });
    }
    this.paused = false;
    this.sendResponse(reqSeq, stepType === 'stepState' ? 'next' : 'stepOut');
  }

  private handleDisconnect(reqSeq: number): void {
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
    this.rap?.close();
    this.rap = null;
    this.sendResponse(reqSeq, 'disconnect');
  }

  private sendResponse(reqSeq: number, command: string, body?: Record<string, unknown>): void {
    this.sendMessage.fire({
      type: 'response',
      request_seq: reqSeq,
      command,
      seq: ++this.seq,
      success: true,
      body,
    } as unknown as vscode.DebugProtocolMessage);
  }

  private sendErrorResponse(reqSeq: number, command: string, message: string): void {
    this.sendMessage.fire({
      type: 'response',
      request_seq: reqSeq,
      command,
      seq: ++this.seq,
      success: false,
      message,
    } as unknown as vscode.DebugProtocolMessage);
  }

  private sendEvent(event: string, body: Record<string, unknown>): void {
    this.sendMessage.fire({
      type: 'event',
      event,
      seq: ++this.seq,
      body,
    } as unknown as vscode.DebugProtocolMessage);
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
    this.rap?.close();
    this.sendMessage.dispose();
  }
}

/**
 * Factory that creates inline ReagentDebugSession instances for each debug session.
 */
export class ReagentDebugAdapterFactory implements vscode.DebugAdapterDescriptorFactory {
  createDebugAdapterDescriptor(
    _session: vscode.DebugSession
  ): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
    return new vscode.DebugAdapterInlineImplementation(new ReagentDebugSession());
  }
}
