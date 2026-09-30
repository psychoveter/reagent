import * as vscode from 'vscode';
import * as path from 'path';
import * as net from 'net';
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind,
} from 'vscode-languageclient/node';
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
import { DiagramController } from './diagramController';
import { ProjectDiagramPanel } from './projectDiagramPanel';
import { ClusterPanelProvider } from './clusterPanel';
import { ReagentTracePanelProvider } from './tracePanel';
import { deployProject } from './deployController';
import { ProjectCodeLensProvider } from './projectCodeLens';
import { McpDevCycle } from './mcpDevCycle';
import { showDebugProtocolLog } from './debugLog';
import { ChildProcess, spawn, execSync } from 'child_process';
import * as fs from 'fs';

let languageClient: LanguageClient | undefined;
let remoteNodeProcess: ChildProcess | null = null;
let remoteNodeChannel: vscode.OutputChannel | null = null;

export function activate(context: vscode.ExtensionContext): void {
  const outputChannel = vscode.window.createOutputChannel('Reagent Language');
  outputChannel.appendLine('Reagent Language extension activating...');

  // ── Language Server ───────────────────────────────────────────────
  const serverModule = context.asAbsolutePath(path.join('out', 'server', 'server.js'));
  const serverOptions: ServerOptions = {
    run: { module: serverModule, transport: TransportKind.ipc },
    debug: { module: serverModule, transport: TransportKind.ipc, options: { execArgv: ['--nolazy', '--inspect=6009'] } },
  };
  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: 'file', language: 'reagent' }],
    outputChannel,
  };
  languageClient = new LanguageClient('reagent-lsp', 'Reagent Language Server', serverOptions, clientOptions);
  languageClient.start();
  context.subscriptions.push({ dispose: () => { languageClient?.stop(); } });

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

  // ── Cluster panel (tree view in explorer + debug sidebar) ────────
  const clusterPanel = new ClusterPanelProvider();
  context.subscriptions.push(clusterPanel);
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider(ClusterPanelProvider.viewType, clusterPanel)
  );
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('reagentDebugCluster', clusterPanel)
  );

  // ── Trace panel (sidebar, outside debug sessions + debug sidebar)
  const tracePanelProvider = new ReagentTracePanelProvider(clusterPanel);
  context.subscriptions.push(tracePanelProvider);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      ReagentTracePanelProvider.viewType,
      tracePanelProvider,
    )
  );
  const debugTracePanelProvider = new ReagentTracePanelProvider(clusterPanel);
  context.subscriptions.push(debugTracePanelProvider);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      'reagentDebugTracePanel',
      debugTracePanelProvider,
    )
  );

  // ── Debug adapter (wired to panel + inline values) ─
  const debugAdapterFactory = new ReagentDebugAdapterFactory({
    debugPanel: debugPanelProvider,
    inlineValues,
  });
  context.subscriptions.push(
    vscode.debug.registerDebugAdapterDescriptorFactory('reagent', debugAdapterFactory)
  );

  let previousToolBarLocation: string | undefined;

  context.subscriptions.push(
    vscode.debug.onDidStartDebugSession(session => {
      if (session.type === 'reagent') {
        vscode.commands.executeCommand('setContext', 'reagent.debugActive', true);
        // Dock the native debug toolbar into the debug viewlet
        const config = vscode.workspace.getConfiguration('debug');
        previousToolBarLocation = config.get<string>('toolBarLocation');
        if (previousToolBarLocation !== 'docked') {
          config.update('toolBarLocation', 'docked', vscode.ConfigurationTarget.Global);
        }
      }
    })
  );

  context.subscriptions.push(
    vscode.debug.onDidTerminateDebugSession(session => {
      if (session.type === 'reagent') {
        inlineValues.clearDecorations();
        debugPanelProvider.clear();
        vscode.commands.executeCommand('setContext', 'reagent.debugActive', false);
        // Restore previous toolbar location
        if (previousToolBarLocation !== undefined && previousToolBarLocation !== 'docked') {
          const config = vscode.workspace.getConfiguration('debug');
          config.update('toolBarLocation', previousToolBarLocation, vscode.ConfigurationTarget.Global);
        }
        previousToolBarLocation = undefined;
      }
    })
  );

  // ── Debug commands (sidebar panel → diagram panel bridge) ────
  context.subscriptions.push(
    vscode.commands.registerCommand('reagent.debug.continue', () => {
      ReagentDiagramPanel.getInstance()?.sendDebugCommand('continue');
    }),
    vscode.commands.registerCommand('reagent.debug.stepState', () => {
      ReagentDiagramPanel.getInstance()?.sendDebugCommand('stepState');
    }),
    vscode.commands.registerCommand('reagent.debug.stepOver', () => {
      ReagentDiagramPanel.getInstance()?.sendDebugCommand('stepOver');
    }),
    vscode.commands.registerCommand('reagent.debug.stepInto', () => {
      ReagentDiagramPanel.getInstance()?.sendDebugCommand('stepInto');
    }),
    vscode.commands.registerCommand('reagent.debug.restart', () => {
      ReagentDiagramPanel.getInstance()?.sendDebugCommand('restart');
    }),
    vscode.commands.registerCommand('reagent.debug.stop', () => {
      ReagentDiagramPanel.getInstance()?.sendDebugCommand('stop');
    }),
    vscode.commands.registerCommand('reagent.debug.showProtocolLog', () => {
      showDebugProtocolLog(false);
    }),
  );
  debugPanelProvider.setDiagramPanelAccessor(() => ReagentDiagramPanel.getInstance() ?? null);

  // ── Diagram ↔ Debug controller ──────────────────────────────
  const diagramController = new DiagramController();
  context.subscriptions.push(diagramController);

  // ── Run controller (no-debug, in-process) ─────────────────────
  const runController = new RunController();
  context.subscriptions.push(runController);

  // ── CodeLens (▶ Run / 🔍 Debug on protocol lines) ────────────
  const codeLensProvider = new ReagentCodeLensProvider();
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider({ language: 'reagent' }, codeLensProvider)
  );
  context.subscriptions.push(codeLensProvider);

  // ── CodeLens for reagent.json (Compile / Deploy / Trigger) ────
  const projectCodeLens = new ProjectCodeLensProvider();
  context.subscriptions.push(projectCodeLens);
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(
      { pattern: '**/reagent.json' },
      projectCodeLens,
    )
  );

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

  // ── Trace output channel (always available) ─────────────────────
  const traceChannel = vscode.window.createOutputChannel('Reagent Traces');
  context.subscriptions.push(traceChannel);

  context.subscriptions.push(
    vscode.commands.registerCommand('reagent.showTraceTimeline', () => {
      traceChannel.show(true);
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
    vscode.commands.registerCommand('reagent.openDiagram', async (uri?: vscode.Uri, protocolName?: string) => {
      const panel = ReagentDiagramPanel.createOrShow(context.extensionUri, clusterPanel);
      if (uri) {
        const doc = await vscode.workspace.openTextDocument(uri);
        await panel.openDocumentProtocol(doc, protocolName);
        return;
      }
      const editor = vscode.window.activeTextEditor;
      if (editor?.document.languageId === 'reagent') {
        await panel.openDocumentProtocol(editor.document, protocolName);
        return;
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('reagent.openProjectDiagram', () => {
      ProjectDiagramPanel.createOrShow();
    })
  );

  clusterPanel.setTraceChannel(traceChannel);

  // Make cluster view visible by default when reagent extension is active
  vscode.commands.executeCommand('setContext', 'reagent.clusterVisible', true);

  context.subscriptions.push(
    vscode.commands.registerCommand('reagent.connectCluster', async () => {
      try {
        await clusterPanel.connect();
        vscode.window.showInformationMessage('Connected to Reagent cluster');
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to connect to Reagent cluster: ${err instanceof Error ? err.message : String(err)}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('reagent.disconnectCluster', () => {
      clusterPanel.disconnect();
      vscode.window.showInformationMessage('Disconnected from Reagent cluster');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('reagent.refreshCluster', () => {
      if (clusterPanel.getRapClient()?.connected) {
        clusterPanel.getRapClient()!.send({ rap: 'ClusterStatus', payload: {} });
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('reagent.triggerProtocol', () => {
      if (!clusterPanel.getRapClient()?.connected) {
        vscode.window.showWarningMessage('Connect to the cluster first (Reagent: Connect to Cluster)');
        return;
      }
      ReagentDiagramPanel.createOrShow(context.extensionUri, clusterPanel);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('reagent.compileProject', async (projectDir?: string) => {
      if (!projectDir) {
        const editor = vscode.window.activeTextEditor;
        if (editor && path.basename(editor.document.uri.fsPath) === 'reagent.json') {
          projectDir = path.dirname(editor.document.uri.fsPath);
        }
      }
      if (!projectDir) {
        vscode.window.showWarningMessage('Open a reagent.json file or provide a project directory');
        return;
      }

      const cliPath = context.asAbsolutePath(path.join('lang', 'cli.js'));
      const terminal = vscode.window.createTerminal({
        name: 'Reagent Compile',
        cwd: projectDir,
      });
      terminal.show();
      terminal.sendText(`node "${cliPath}" build "${projectDir}"`);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('reagent.deployProject', (projectDir?: string) => {
      deployProject(clusterPanel, projectDir);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('reagent.inspectNode', (treeItem?: any) => {
      let nodeId: string | undefined;
      if (treeItem?.node?.nodeId) {
        nodeId = treeItem.node.nodeId;
      }
      if (!nodeId) {
        const nodes = clusterPanel.getState().nodes;
        if (nodes.length === 0) {
          vscode.window.showWarningMessage('No nodes connected');
          return;
        }
        vscode.window.showQuickPick(
          nodes.map(n => ({ label: n.nodeId, description: n.status })),
          { placeHolder: 'Select node to inspect' }
        ).then(pick => {
          if (pick) clusterPanel.requestNodeInspect(pick.label);
        });
        return;
      }
      clusterPanel.requestNodeInspect(nodeId);
    })
  );

  // ── Cluster tree → diagram/source navigation ────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('reagent.clusterOpenProtocol', async (protocolName?: string) => {
      if (!protocolName) return;

      // Search workspace for .rg files containing this protocol definition
      const files = await vscode.workspace.findFiles('**/*.rg', '**/node_modules/**', 100);
      for (const uri of files) {
        try {
          const doc = await vscode.workspace.openTextDocument(uri);
          const text = doc.getText();
          const pattern = new RegExp(`^\\s*protocol\\s+${protocolName}\\b`, 'm');
          const match = pattern.exec(text);
          if (match) {
            const line = text.substring(0, match.index).split('\n').length - 1;
            await vscode.window.showTextDocument(doc, {
              selection: new vscode.Range(line, 0, line, 0),
              viewColumn: vscode.ViewColumn.One,
            });
            ReagentDiagramPanel.createOrShow(context.extensionUri, clusterPanel);
            return;
          }
        } catch { /* skip unreadable files */ }
      }

      vscode.window.showWarningMessage(`Protocol "${protocolName}" not found in workspace .rg files`);
    })
  );

  // ── Dev Cycle: one-click setup ──────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('reagent.devCycle', async () => {
      const devChannel = remoteNodeChannel ?? vscode.window.createOutputChannel('Reagent Dev Cycle');
      remoteNodeChannel = devChannel;
      context.subscriptions.push(devChannel);
      devChannel.show(true);

      // 1. Find project root from active .rg file
      const editor = vscode.window.activeTextEditor;
      let projectRoot: string | undefined;
      if (editor) {
        let dir = path.dirname(editor.document.uri.fsPath);
        for (let i = 0; i < 6; i++) {
          if (fs.existsSync(path.join(dir, 'reagent.json'))) { projectRoot = dir; break; }
          const parent = path.dirname(dir);
          if (parent === dir) break;
          dir = parent;
        }
      }
      if (!projectRoot) {
        vscode.window.showWarningMessage('Open a .rg file inside a Reagent project first');
        return;
      }

      devChannel.appendLine(`[DevCycle] Project: ${projectRoot}`);
      devChannel.appendLine('[DevCycle] This channel shows dev-cycle steps plus stdout/stderr from the project node runner.');

      const composePath = findComposePath(projectRoot);
      if (composePath) {
        if (await canConnectToPort('127.0.0.1', 2379)) {
          devChannel.appendLine('[DevCycle] Reusing existing etcd on 127.0.0.1:2379');
        } else {
          devChannel.appendLine(`[DevCycle] Starting docker compose from ${composePath}`);
          try {
            execSync('docker compose up -d', {
              cwd: path.dirname(composePath),
              timeout: 60000,
              stdio: 'pipe',
            });
            await waitForPort('127.0.0.1', 2379, 15000);
            devChannel.appendLine('[DevCycle] etcd is reachable');
          } catch (err: any) {
            const stderr = err.stderr?.toString() ?? '';
            devChannel.appendLine(`[DevCycle] Failed to start docker compose:\n${stderr}`);
            vscode.window.showErrorMessage('Dev Cycle: failed to start docker compose');
            return;
          }
        }
      }

      devChannel.appendLine('[DevCycle] Compiling project...');
      const cliPath = context.asAbsolutePath(path.join('lang', 'cli.js'));
      try {
        execSync(`node "${cliPath}" build "${projectRoot}"`, {
          cwd: projectRoot,
          timeout: 30000,
          stdio: 'pipe',
        });
        devChannel.appendLine('[DevCycle] Compilation complete');
      } catch (err: any) {
        const stderr = err.stderr?.toString() ?? '';
        const stdout = err.stdout?.toString() ?? '';
        devChannel.appendLine(`[DevCycle] Compile failed:\n${stdout}\n${stderr}`);
        vscode.window.showErrorMessage('Dev Cycle: compilation failed');
        return;
      }

      if (remoteNodeProcess && !remoteNodeProcess.killed) {
        devChannel.appendLine('[DevCycle] Stopping previous node process...');
        remoteNodeProcess.kill('SIGTERM');
        remoteNodeProcess = null;
        await new Promise(r => setTimeout(r, 500));
      }

      const nodeRunner = findProjectNodeRunner(projectRoot);
      if (!nodeRunner) {
        vscode.window.showErrorMessage('Dev Cycle: cannot find run_node.ts, run_node.js, or run_node.sh in project root');
        return;
      }
      const tsxBinary = findTsxBinary(projectRoot);
      if (nodeRunner.endsWith('.ts') && !tsxBinary) {
        vscode.window.showErrorMessage('Dev Cycle: cannot locate tsx binary for TypeScript node runner');
        return;
      }

      devChannel.appendLine(`[DevCycle] Starting node runner: ${nodeRunner}`);
      remoteNodeProcess = spawnNodeRunner(nodeRunner, projectRoot, tsxBinary);
      remoteNodeProcess.stdout?.on('data', (data: Buffer) => {
        for (const line of data.toString().split(/\r?\n/)) {
          if (line.length > 0) devChannel.appendLine(`[node] ${line}`);
        }
      });
      remoteNodeProcess.stderr?.on('data', (data: Buffer) => {
        for (const line of data.toString().split(/\r?\n/)) {
          if (line.length > 0) devChannel.appendLine(`[node:stderr] ${line}`);
        }
      });
      remoteNodeProcess.on('exit', (code) => {
        devChannel.appendLine(`[DevCycle] Node process exited (code ${code})`);
        remoteNodeProcess = null;
      });

      await new Promise(r => setTimeout(r, 1000));

      devChannel.appendLine('[DevCycle] Connecting cluster tooling...');
      try {
        await clusterPanel.connect();
      } catch (err) {
        devChannel.appendLine(`[DevCycle] Cluster connect failed: ${err instanceof Error ? err.message : String(err)}`);
        vscode.window.showErrorMessage(`Dev Cycle: failed to connect cluster tooling: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      clusterPanel.getRapClient()?.send({ rap: 'ClusterStatus', payload: {} });

      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        const state = clusterPanel.getState();
        if (state.nodes.length > 0) break;
        await new Promise(r => setTimeout(r, 500));
        clusterPanel.getRapClient()?.send({ rap: 'ClusterStatus', payload: {} });
      }

      if (clusterPanel.getState().nodes.length === 0) {
        vscode.window.showErrorMessage('Dev Cycle: node did not register in time');
        return;
      }

      devChannel.appendLine(`[DevCycle] Registered nodes: ${clusterPanel.getState().nodes.map(n => n.nodeId).join(', ')}`);
      devChannel.appendLine('[DevCycle] Deploying project...');
      await deployProject(clusterPanel, projectRoot);
      devChannel.appendLine('[DevCycle] Deploy complete');
      ReagentDiagramPanel.createOrShow(context.extensionUri, clusterPanel);
      devChannel.appendLine('[DevCycle] Ready');
    })
  );

  // ── MCP Dev Cycle: NATS + etcd + admin host + compile + deploy ─────────
  const mcpDevCycle = new McpDevCycle(
    clusterPanel,
    () => context.asAbsolutePath(path.join('lang', 'cli.js')),
  );
  context.subscriptions.push(mcpDevCycle);

  mcpDevCycle.onStatusChange((health) => {
    clusterPanel.setInfraHealth(health);
  });

  context.subscriptions.push(
    vscode.commands.registerCommand('reagent.mcpDevCycle', () => mcpDevCycle.start())
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('reagent.stopMcpDevCycle', () => mcpDevCycle.stop())
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('reagent.teardownMcpDevCycle', () => mcpDevCycle.stop(true))
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('reagent.mcpRedeploy', () => mcpDevCycle.recompileAndRedeploy())
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('reagent.lspStatus', async () => {
      if (!languageClient) {
        vscode.window.showWarningMessage('Reagent LSP not running');
        return;
      }
      try {
        const status = await languageClient.sendRequest('reagent/lspStatus');
        const s = status as { parser: { state: string; error?: string }; indexedDocuments: number; uptimeSeconds: number };
        const parserLine = s.parser.state === 'error'
          ? `Parser: error — ${s.parser.error}`
          : `Parser: ${s.parser.state}`;
        const lines = [
          parserLine,
          `Indexed documents: ${s.indexedDocuments}`,
          `Uptime: ${s.uptimeSeconds}s`,
        ];
        vscode.window.showInformationMessage(`Reagent LSP Status\n${lines.join('\n')}`);
        outputChannel.appendLine(`[LSP Status] ${lines.join(' | ')}`);
      } catch (err) {
        vscode.window.showErrorMessage(`LSP Status request failed: ${err}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('reagent.stopDevCycle', () => {
      if (remoteNodeProcess && !remoteNodeProcess.killed) {
        remoteNodeProcess.kill('SIGTERM');
        remoteNodeProcess = null;
        remoteNodeChannel?.appendLine('[DevCycle] Node process stopped');
      }
      vscode.window.showInformationMessage('Dev Cycle: node process stopped');
    })
  );

  outputChannel.appendLine('Reagent Language extension activated.');
}

function findComposePath(projectRoot: string): string | null {
  const candidates = [
    path.join(projectRoot, 'docker-compose.yml'),
    path.join(projectRoot, 'docker-compose.yaml'),
    path.join(projectRoot, 'compose.yml'),
    path.join(projectRoot, 'compose.yaml'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function findProjectNodeRunner(projectRoot: string): string | null {
  const candidates = [
    path.join(projectRoot, 'run_node.ts'),
    path.join(projectRoot, 'run_node.js'),
    path.join(projectRoot, 'run_node.mjs'),
    path.join(projectRoot, 'run_node.sh'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function findTsxBinary(projectRoot: string): string | null {
  const candidates = [
    path.resolve(projectRoot, '../../../runtime/ts/node_modules/.bin/tsx'),
    path.resolve(projectRoot, '../../../../runtime/ts/node_modules/.bin/tsx'),
  ];
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    candidates.push(
      path.join(folder.uri.fsPath, 'projects', 'reagent', 'runtime', 'ts', 'node_modules', '.bin', 'tsx'),
      path.join(folder.uri.fsPath, 'runtime', 'ts', 'node_modules', '.bin', 'tsx'),
    );
  }
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function spawnNodeRunner(nodeRunner: string, cwd: string, tsxBinary?: string | null): ChildProcess {
  if (nodeRunner.endsWith('.ts')) {
    return spawn(tsxBinary ?? 'tsx', [nodeRunner], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }
  if (nodeRunner.endsWith('.sh')) {
    return spawn('bash', [nodeRunner], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }
  return spawn(process.execPath, [nodeRunner], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function waitForPort(host: string, port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await canConnectToPort(host, port);
    if (ok) return;
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(`Timeout waiting for ${host}:${port}`);
}

async function canConnectToPort(host: string, port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(1000);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => { socket.destroy(); resolve(false); });
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
    socket.connect(port, host);
  });
}

export function deactivate(): void {
  if (remoteNodeProcess && !remoteNodeProcess.killed) {
    remoteNodeProcess.kill('SIGTERM');
    remoteNodeProcess = null;
  }
}
