import * as vscode from 'vscode';
import * as path from 'path';

/**
 * CodeLens provider for reagent.json files.
 * Shows ▶ Compile and ☁ Deploy buttons on the first line.
 */
export class ProjectCodeLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onDidChange.event;
  private disposables: vscode.Disposable[] = [];

  constructor() {
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument(e => {
        if (path.basename(e.document.uri.fsPath) === 'reagent.json') {
          this._onDidChange.fire();
        }
      })
    );
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (path.basename(document.uri.fsPath) !== 'reagent.json') return [];

    const projectDir = path.dirname(document.uri.fsPath);
    const range = new vscode.Range(0, 0, 0, 0);

    return [
      new vscode.CodeLens(range, {
        title: '$(play) Compile',
        command: 'reagent.compileProject',
        arguments: [projectDir],
        tooltip: 'Compile all protocols in this project (reagent-lang build)',
      }),
      new vscode.CodeLens(range, {
        title: '$(cloud-upload) Deploy to Cluster',
        command: 'reagent.deployProject',
        arguments: [projectDir],
        tooltip: 'Deploy compiled IR to connected cluster nodes',
      }),
      new vscode.CodeLens(range, {
        title: '$(run) Trigger',
        command: 'reagent.triggerProtocol',
        arguments: [],
        tooltip: 'Trigger a protocol on the cluster',
      }),
    ];
  }

  dispose(): void {
    this._onDidChange.dispose();
    for (const d of this.disposables) d.dispose();
  }
}
