/**
 * Virtual document provider for embedded language content in Reagent agent zones.
 *
 * Strategy:
 * For each .rg file, we create virtual documents (one per embedded language)
 * that contain only the code from agent zones of that language. Non-zone lines
 * are replaced with blank lines to preserve line-number alignment with the
 * original .rg file. This lets VS Code's built-in TypeScript/Python/etc.
 * language services provide completions, diagnostics, and hover on these
 * virtual documents, which we then project back to the original .rg file.
 */

import * as vscode from 'vscode';
import { parseReagentDocument, langTagToLanguageId, type AgentZoneRegion } from './reagentParser';

export const REAGENT_EMBEDDED_SCHEME = 'reagent-embedded';

interface EmbeddedDocInfo {
  /** The original .rg URI */
  originalUri: vscode.Uri;
  /** The target language id (typescript, javascript, python, kotlin) */
  languageId: string;
  /** The lang tag (ts, js, py, kt) */
  langTag: string;
}

/**
 * Encode an embedded virtual document URI.
 * Format: reagent-embedded:///<original-path>.virtual.<lang>
 */
export function makeEmbeddedUri(originalUri: vscode.Uri, langTag: string): vscode.Uri {
  const langId = langTagToLanguageId(langTag);
  // Use the extension that matches the language for proper language detection
  const ext = langTag === 'py' ? '.py' : langTag === 'kt' ? '.kt' : langTag === 'js' ? '.js' : '.ts';
  return vscode.Uri.parse(
    `${REAGENT_EMBEDDED_SCHEME}://${originalUri.path}.virtual${ext}`
  );
}

export function parseEmbeddedUri(uri: vscode.Uri): EmbeddedDocInfo | undefined {
  const path = uri.path;
  const virtualMatch = path.match(/^(.+\.rg)\.virtual\.(ts|js|py|kt)$/);
  if (!virtualMatch) { return undefined; }

  const originalPath = virtualMatch[1];
  const langTag = virtualMatch[2];

  return {
    originalUri: vscode.Uri.file(originalPath),
    languageId: langTagToLanguageId(langTag),
    langTag,
  };
}

/**
 * Generate a virtual document's text content for a given language.
 * Non-zone lines are blank (preserving line count for position mapping).
 */
export function generateVirtualContent(
  originalText: string,
  langTag: string,
  zones: AgentZoneRegion[]
): string {
  const lines = originalText.split('\n');
  const result = new Array(lines.length).fill('');

  // Preamble: inject reagent runtime type stubs at the top for TypeScript
  const preamble: string[] = [];
  if (langTag === 'ts' || langTag === 'js') {
    preamble.push(
      '// @ts-nocheck',
      'declare const $ctx: Record<string, any>;',
      'declare const reagent: {',
      '  invoke(proto: any, ...args: any[]): any;',
      '  spawn(proto: any, ...args: any[]): any;',
      '  return(value: any): void;',
      '  emit(event: string, props: any): void;',
      '};',
      ''
    );
  }

  // Place preamble lines (overwrite first N blank lines)
  for (let p = 0; p < preamble.length && p < result.length; p++) {
    result[p] = preamble[p];
  }

  // Fill in zone body lines
  for (const zone of zones) {
    if (zone.lang !== langTag) { continue; }
    for (let line = zone.bodyStartLine; line < zone.bodyEndLine; line++) {
      if (line < lines.length) {
        result[line] = lines[line];
      }
    }
  }

  return result.join('\n');
}

export class ReagentVirtualDocumentProvider implements vscode.TextDocumentContentProvider {
  private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._onDidChange.event;

  /** Notify that a virtual document has changed (e.g. when the .rg file is edited) */
  fireChange(uri: vscode.Uri): void {
    this._onDidChange.fire(uri);
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const info = parseEmbeddedUri(uri);
    if (!info) { return ''; }

    // Read the original .rg file
    let originalText: string;
    try {
      const bytes = await vscode.workspace.fs.readFile(info.originalUri);
      originalText = new TextDecoder('utf-8').decode(bytes);
    } catch {
      return '';
    }

    const parsed = parseReagentDocument(originalText);
    const relevantZones = parsed.zones.filter(z => z.lang === info.langTag);

    return generateVirtualContent(originalText, info.langTag, relevantZones);
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}
