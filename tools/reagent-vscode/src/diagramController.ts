import * as vscode from 'vscode';
import { ReagentDiagramPanel } from './diagramPanel';
import { ReagentDebugSession } from './reagentDebugAdapter';
import type { RapClient } from './rapClient';

/**
 * Bridges DAP Stopped events to the diagram webview.
 *
 * With the new mode-based panel, the controller's role is simpler:
 * - On session start: clear visited states, attach to RAP
 * - On Stopped: forward state ID to panel.updateDebug() (single path)
 * - On session end: signal panel (panel handles its own transition to replay)
 *
 * The panel's own RAP listener (ensureStoppedListener) handles cluster-debug
 * Stopped events. This controller handles local-debug DAP events and acts as
 * a secondary path for cluster-debug via custom debug events.
 */
export class DiagramController implements vscode.Disposable {
  private disposables: vscode.Disposable[] = [];
  private visitedStates = new Set<string>();
  private rapDisposable: vscode.Disposable | null = null;

  constructor() {
    this.disposables.push(
      vscode.debug.onDidStartDebugSession(session => {
        if (session.type === 'reagent') {
          this.onSessionStart();
        }
      }),
    );

    this.disposables.push(
      vscode.debug.onDidTerminateDebugSession(session => {
        if (session.type === 'reagent') {
          this.onSessionEnd();
        }
      }),
    );

    this.disposables.push(
      vscode.debug.onDidReceiveDebugSessionCustomEvent(e => {
        if (e.session.type === 'reagent' && e.event === 'stopped') {
          const stateId = e.body?.stateId as string | undefined;
          if (stateId) {
            this.onStopped(stateId);
          }
        }
      }),
    );
  }

  private onSessionStart(): void {
    this.visitedStates.clear();
    this.attachToRap();
  }

  private attachToRap(): void {
    this.rapDisposable?.dispose();
    this.rapDisposable = null;

    const poll = setInterval(() => {
      const session = ReagentDebugSession.activeSession;
      const rap = session?.getRapClient();
      if (rap?.connected) {
        clearInterval(poll);
        this.listenToRap(rap);
      }
    }, 200);

    setTimeout(() => clearInterval(poll), 10_000);
  }

  private listenToRap(rap: RapClient): void {
    this.rapDisposable = rap.on('Stopped', (msg) => {
      const payload = (msg.payload || {}) as Record<string, unknown>;
      const stateId = payload.stateId as string | undefined;
      if (stateId) {
        this.onStopped(stateId);
      }
    });
  }

  private onStopped(stateId: string): void {
    this.visitedStates.add(stateId);

    const panel = ReagentDiagramPanel.getInstance();
    if (panel) {
      // Single update path — panel dispatches internally
      panel.updateDebug(stateId, this.visitedStates);
    }
  }

  private onSessionEnd(): void {
    this.rapDisposable?.dispose();
    this.rapDisposable = null;
    // Panel handles session-end transition via its own onDidTerminateDebugSession listener
  }

  dispose(): void {
    this.rapDisposable?.dispose();
    for (const d of this.disposables) d.dispose();
  }
}
