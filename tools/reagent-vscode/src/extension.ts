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
import { ReagentDebugAdapterFactory } from './reagentDebugAdapter';
import { ReagentDebugPanelProvider } from './debugPanelProvider';
import { ReagentInlineValues } from './inlineValues';

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

  // ── Debug adapter ───────────────────────────────────────────────
  const debugAdapterFactory = new ReagentDebugAdapterFactory();
  context.subscriptions.push(
    vscode.debug.registerDebugAdapterDescriptorFactory('reagent', debugAdapterFactory)
  );

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

  context.subscriptions.push(
    vscode.debug.onDidTerminateDebugSession(() => {
      inlineValues.clearDecorations();
      debugPanelProvider.clear();
    })
  );

  // ── Commands ───────────────────────────────────────────────────
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
      const agentName = await vscode.window.showInputBox({
        prompt: 'Agent name to inspect',
        placeHolder: 'e.g. handler',
      });
      if (!agentName) return;
      outputChannel.appendLine(`Inspect agent: ${agentName} — use Debug panel`);
    })
  );

  outputChannel.appendLine('Reagent Language extension activated.');
}

export function deactivate(): void {
  // cleanup handled by disposables
}
