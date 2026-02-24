import * as vscode from 'vscode';
import { ReagentDiagramPanel } from './diagramPanel';
import { ReagentDebugSession } from './reagentDebugAdapter';
import type { RapClient } from './rapClient';

/**
 * Bridges DAP Stopped events to the diagram webview:
 * highlights the active IR state and accumulates visited states.
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

    // Also hook into custom debug events if available
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

    // Stop polling after 10s
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
      panel.updateDebug(stateId, this.visitedStates);
    }
  }

  private onSessionEnd(): void {
    this.rapDisposable?.dispose();
    this.rapDisposable = null;

    const panel = ReagentDiagramPanel.getInstance();
    if (panel) {
      panel.updateDebug(undefined, undefined);
    }
  }

  dispose(): void {
    this.rapDisposable?.dispose();
    for (const d of this.disposables) d.dispose();
  }
}
