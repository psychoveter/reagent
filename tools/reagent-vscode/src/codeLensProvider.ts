import * as vscode from 'vscode';

const PROTOCOL_REGEX = /^protocol\s+(\w+)\s*\{/;

export class ReagentCodeLensProvider implements vscode.CodeLensProvider {
  private _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (document.languageId !== 'reagent') return [];

    const lenses: vscode.CodeLens[] = [];
    for (let i = 0; i < document.lineCount; i++) {
      const line = document.lineAt(i);
      const match = PROTOCOL_REGEX.exec(line.text);
      if (match) {
        const range = new vscode.Range(i, 0, i, line.text.length);
        lenses.push(
          new vscode.CodeLens(range, {
            title: '$(type-hierarchy) View',
            command: 'reagent.openDiagram',
            arguments: [document.uri, match[1]],
          }),
        );
      }
    }
    return lenses;
  }

  dispose(): void {
    this._onDidChangeCodeLenses.dispose();
  }
}
