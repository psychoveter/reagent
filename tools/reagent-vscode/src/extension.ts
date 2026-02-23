import * as vscode from 'vscode';
import {
  ReagentVirtualDocumentProvider,
  REAGENT_EMBEDDED_SCHEME,
  makeEmbeddedUri,
} from './virtualDocumentProvider';
import { parseReagentDocument } from './reagentParser';
import {
  registerCompletionDelegation,
  registerHoverDelegation,
  registerDefinitionDelegation,
  setupDiagnosticForwarding,
} from './embeddedLanguageMiddleware';
import { ReagentDebugAdapterFactory, ReagentDebugSession } from './reagentDebugAdapter';
import { ReagentDebugPanelProvider } from './debugPanelProvider';
import { ReagentInlineValues } from './inlineValues';
import { ReagentDiagramPanel } from './diagramPanel';
import { RunController } from './runController';
import { ReagentCodeLensProvider } from './codeLensProvider';
import { RosManager } from './rosManager';

export function activate(context: vscode.ExtensionContext): void {
  const outputChannel = vscode.window.createOutputChannel('Reagent Language');
  outputChannel.appendLine('Reagent Language extension activating...');

  // 1. Register virtual document provider
  const virtualProvider = new ReagentVirtualDocumentProvider();
  const providerRegistration = vscode.workspace.registerTextDocumentContentProvider(
    REAGENT_EMBEDDED_SCHEME,
    virtualProvider
  );
  context.subscriptions.push(providerRegistration);
  context.subscriptions.push(virtualProvider);

  // 2. Track unique embedded languages per open .rg document
  //    and open their virtual documents to activate respective language servers
  const activeVirtualDocs = new Set<string>();

  async function ensureVirtualDocsForReagentFile(document: vscode.TextDocument): Promise<void> {
    if (document.languageId !== 'reagent') { return; }

    const parsed = parseReagentDocument(document.getText());
    const uniqueLangs = new Set(parsed.zones.map(z => z.lang));

    for (const lang of uniqueLangs) {
      const virtualUri = makeEmbeddedUri(document.uri, lang);
      const key = virtualUri.toString();

      if (!activeVirtualDocs.has(key)) {
        activeVirtualDocs.add(key);
        try {
          // Opening the virtual document triggers VS Code to provide
          // language services for its language ID (derived from extension)
          await vscode.workspace.openTextDocument(virtualUri);
          outputChannel.appendLine(`Opened virtual doc: ${virtualUri.toString()}`);
        } catch (err) {
          outputChannel.appendLine(`Failed to open virtual doc: ${err}`);
        }
      }
    }
  }

  // 3. When .rg files are opened or changed, refresh virtual docs
  const onOpenDisposable = vscode.workspace.onDidOpenTextDocument(async (doc) => {
    if (doc.languageId === 'reagent') {
      await ensureVirtualDocsForReagentFile(doc);
    }
  });

  const onChangeDisposable = vscode.workspace.onDidChangeTextDocument(async (e) => {
    if (e.document.languageId === 'reagent') {
      // Notify virtual document provider that content changed
      const parsed = parseReagentDocument(e.document.getText());
      const uniqueLangs = new Set(parsed.zones.map(z => z.lang));
      for (const lang of uniqueLangs) {
        const virtualUri = makeEmbeddedUri(e.document.uri, lang);
        virtualProvider.fireChange(virtualUri);
      }
    }
  });

  context.subscriptions.push(onOpenDisposable);
  context.subscriptions.push(onChangeDisposable);

  // 4. Register language feature delegation
  registerCompletionDelegation(context);
  registerHoverDelegation(context);
  registerDefinitionDelegation(context);

  // 5. Setup diagnostic forwarding
  const diagnosticCollection = vscode.languages.createDiagnosticCollection('reagent-embedded');
  context.subscriptions.push(diagnosticCollection);
  setupDiagnosticForwarding(context, diagnosticCollection);

  // 6. Open virtual docs for any already-open .rg files
  for (const doc of vscode.workspace.textDocuments) {
    if (doc.languageId === 'reagent') {
      ensureVirtualDocsForReagentFile(doc);
    }
  }

  // ── Debug panel webview ────────────────────────────────────────
  const debugPanelProvider = new ReagentDebugPanelProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      ReagentDebugPanelProvider.viewType,
      debugPanelProvider
    )
  );

  // ── Inline value decorations ───────────────────────────────────
  const inlineValues = new ReagentInlineValues();
  context.subscriptions.push(inlineValues);

  // ── ROS manager (auto-start/stop) ──────────────────────────────
  const rosManager = new RosManager();
  context.subscriptions.push(rosManager);

  // ── Debug adapter (wired to panel + inline values + ROS manager) ─
  const debugAdapterFactory = new ReagentDebugAdapterFactory({
    debugPanel: debugPanelProvider,
    inlineValues,
  }, rosManager);
  context.subscriptions.push(
    vscode.debug.registerDebugAdapterDescriptorFactory('reagent', debugAdapterFactory)
  );

  context.subscriptions.push(
    vscode.debug.onDidTerminateDebugSession(() => {
      inlineValues.clearDecorations();
      debugPanelProvider.clear();
    })
  );

  // ── Run controller (no-debug, in-process) ─────────────────────
  const runController = new RunController();
  context.subscriptions.push(runController);

  // ── CodeLens (▶ Run / 🔍 Debug on protocol lines) ────────────
  const codeLensProvider = new ReagentCodeLensProvider();
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider({ language: 'reagent' }, codeLensProvider)
  );
  context.subscriptions.push(codeLensProvider);

  // ── Commands ───────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('reagent.run', async (rgFilePath?: string) => {
      if (!rgFilePath) {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.languageId !== 'reagent') {
          vscode.window.showWarningMessage('Open a .rg file first');
          return;
        }
        rgFilePath = editor.document.uri.fsPath;
      }
      await runController.run(rgFilePath);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('reagent.startDebug', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.languageId !== 'reagent') {
        vscode.window.showWarningMessage('Open a .rg file first');
        return;
      }
      await vscode.debug.startDebugging(undefined, {
        type: 'reagent',
        request: 'launch',
        name: 'Debug Reagent Protocol',
        rgFile: editor.document.uri.fsPath,
      });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('reagent.showTraceTimeline', () => {
      vscode.commands.executeCommand('reagentDebugPanel.focus');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('reagent.inspectAgent', async () => {
      const session = ReagentDebugSession.activeSession;
      const rap = session?.getRapClient();
      const sessionId = session?.getSessionId();
      if (!rap?.connected || !sessionId) {
        vscode.window.showWarningMessage('No active Reagent debug session');
        return;
      }

      const agentName = await vscode.window.showInputBox({
        prompt: 'Agent name to inspect',
        placeHolder: 'e.g. handler',
      });
      if (!agentName) return;

      rap.send({
        rap: 'GetState',
        sessionId,
        payload: { sessionId, agentName },
      });

      const disposable = rap.on('StateSnapshot', (msg) => {
        disposable.dispose();
        const snap = (msg.payload || {}) as Record<string, unknown>;
        outputChannel.appendLine(`\n── Inspect: ${agentName} ──`);
        outputChannel.appendLine(`$self: ${JSON.stringify(snap.self, null, 2)}`);
        if (snap.ctx) outputChannel.appendLine(`$ctx: ${JSON.stringify(snap.ctx, null, 2)}`);
        const held = snap.heldMessages as unknown[] | undefined;
        if (held?.length) outputChannel.appendLine(`Held messages: ${JSON.stringify(held, null, 2)}`);
        const traces = snap.recentTraces as unknown[] | undefined;
        if (traces?.length) outputChannel.appendLine(`Recent traces (last ${traces.length}):`);
        outputChannel.show(true);
      });

      const errorDisposable = rap.on('InspectError', (msg) => {
        errorDisposable.dispose();
        const err = (msg.payload as Record<string, unknown>)?.error || 'Unknown error';
        vscode.window.showErrorMessage(`Inspect ${agentName}: ${err}`);
      });

      setTimeout(() => { disposable.dispose(); errorDisposable.dispose(); }, 5000);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('reagent.openDiagram', () => {
      ReagentDiagramPanel.createOrShow(context.extensionUri);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('reagent.startRos', () => rosManager.start())
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('reagent.stopRos', () => rosManager.stop())
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('reagent.toggleRos', () => {
      if (rosManager.running) { rosManager.stop(); } else { rosManager.start(); }
    })
  );

  outputChannel.appendLine('Reagent Language extension activated.');
}

export function deactivate(): void {
  // cleanup handled by disposables
}
