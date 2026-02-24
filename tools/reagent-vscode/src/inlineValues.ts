import * as vscode from 'vscode';

const decorationType = vscode.window.createTextEditorDecorationType({
  after: {
    color: new vscode.ThemeColor('editorCodeLens.foreground'),
    fontStyle: 'italic',
    margin: '0 0 0 2em',
  },
  rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
});

/**
 * Manages inline value decorations for Reagent debug sessions.
 * Shows $ctx, $self, and $flow values at the current paused line.
 */
export class ReagentInlineValues implements vscode.Disposable {
  private disposables: vscode.Disposable[] = [];
  private currentDecorations: vscode.DecorationOptions[] = [];

  constructor() {
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(() => this.clearDecorations())
    );
  }

  showValues(
    filePath: string,
    line: number,
    ctx: Record<string, unknown>,
    self: Record<string, unknown>,
    flow?: Record<string, unknown>,
  ): void {
    const editor = vscode.window.visibleTextEditors.find(
      e => e.document.uri.fsPath === filePath && e.document.languageId === 'reagent'
    );
    if (!editor) return;

    const decorations: vscode.DecorationOptions[] = [];
    const zeroBasedLine = line - 1;

    const ctxEntries = Object.entries(ctx);
    const selfEntries = Object.entries(self);
    const flowEntries = Object.entries(flow ?? {});

    if (ctxEntries.length > 0) {
      const ctxText = ctxEntries
        .map(([k, v]) => `$ctx.${k} = ${formatValue(v)}`)
        .join('  ');
      decorations.push({
        range: new vscode.Range(zeroBasedLine, 0, zeroBasedLine, 0),
        renderOptions: {
          after: { contentText: `  ${ctxText}` },
        },
      });
    }

    if (selfEntries.length > 0 && zeroBasedLine + 1 < editor.document.lineCount) {
      const selfText = selfEntries
        .map(([k, v]) => `$self.${k} = ${formatValue(v)}`)
        .join('  ');
      decorations.push({
        range: new vscode.Range(zeroBasedLine + 1, 0, zeroBasedLine + 1, 0),
        renderOptions: {
          after: { contentText: `  ${selfText}` },
        },
      });
    }

    if (flowEntries.length > 0 && zeroBasedLine + 2 < editor.document.lineCount) {
      const flowText = flowEntries
        .map(([k, v]) => `$flow.${k} = ${formatValue(v)}`)
        .join('  ');
      decorations.push({
        range: new vscode.Range(zeroBasedLine + 2, 0, zeroBasedLine + 2, 0),
        renderOptions: {
          after: { contentText: `  ${flowText}` },
        },
      });
    }

    this.currentDecorations = decorations;
    editor.setDecorations(decorationType, decorations);
  }

  clearDecorations(): void {
    this.currentDecorations = [];
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.languageId === 'reagent') {
        editor.setDecorations(decorationType, []);
      }
    }
  }

  dispose(): void {
    this.clearDecorations();
    for (const d of this.disposables) d.dispose();
    decorationType.dispose();
  }
}

function formatValue(v: unknown): string {
  if (typeof v === 'string') return `"${v}"`;
  if (v === null || v === undefined) return String(v);
  if (typeof v === 'object') {
    const s = JSON.stringify(v);
    return s.length > 60 ? s.slice(0, 57) + '...' : s;
  }
  return String(v);
}
