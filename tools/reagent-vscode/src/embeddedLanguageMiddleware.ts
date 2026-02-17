/**
 * Middleware that intercepts VS Code language features (completions, hover,
 * diagnostics) for .rg files and delegates to the appropriate embedded
 * language service via virtual documents.
 */

import * as vscode from 'vscode';
import {
  parseReagentDocument,
  langTagToLanguageId,
  type AgentZoneRegion,
} from './reagentParser';
import { makeEmbeddedUri } from './virtualDocumentProvider';

/**
 * Determine which agent zone (if any) a position falls inside.
 */
function findZoneAtPosition(
  zones: AgentZoneRegion[],
  position: vscode.Position
): AgentZoneRegion | undefined {
  for (const zone of zones) {
    if (position.line >= zone.bodyStartLine && position.line < zone.bodyEndLine) {
      return zone;
    }
  }
  return undefined;
}

/**
 * Register completion provider that delegates to embedded language services.
 */
export function registerCompletionDelegation(
  context: vscode.ExtensionContext
): void {
  const provider = vscode.languages.registerCompletionItemProvider(
    { language: 'reagent' },
    {
      async provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken,
        completionContext: vscode.CompletionContext
      ): Promise<vscode.CompletionList | undefined> {
        const parsed = parseReagentDocument(document.getText());
        const zone = findZoneAtPosition(parsed.zones, position);
        if (!zone) { return undefined; }

        const virtualUri = makeEmbeddedUri(document.uri, zone.lang);

        try {
          const completions = await vscode.commands.executeCommand<vscode.CompletionList>(
            'vscode.executeCompletionItemProvider',
            virtualUri,
            position,
            completionContext.triggerCharacter
          );
          return completions;
        } catch {
          return undefined;
        }
      },
    },
    '.', '"', "'", '/', '@', '<', '$'
  );

  context.subscriptions.push(provider);
}

/**
 * Register hover provider that delegates to embedded language services.
 */
export function registerHoverDelegation(
  context: vscode.ExtensionContext
): void {
  const provider = vscode.languages.registerHoverProvider(
    { language: 'reagent' },
    {
      async provideHover(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken
      ): Promise<vscode.Hover | undefined> {
        const parsed = parseReagentDocument(document.getText());
        const zone = findZoneAtPosition(parsed.zones, position);
        if (!zone) { return undefined; }

        const virtualUri = makeEmbeddedUri(document.uri, zone.lang);

        try {
          const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
            'vscode.executeHoverProvider',
            virtualUri,
            position
          );
          if (hovers && hovers.length > 0) {
            return hovers[0];
          }
        } catch {
          // ignore
        }
        return undefined;
      },
    }
  );

  context.subscriptions.push(provider);
}

/**
 * Register definition provider that delegates to embedded language services.
 */
export function registerDefinitionDelegation(
  context: vscode.ExtensionContext
): void {
  const provider = vscode.languages.registerDefinitionProvider(
    { language: 'reagent' },
    {
      async provideDefinition(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken
      ): Promise<vscode.Definition | undefined> {
        const parsed = parseReagentDocument(document.getText());
        const zone = findZoneAtPosition(parsed.zones, position);
        if (!zone) { return undefined; }

        const virtualUri = makeEmbeddedUri(document.uri, zone.lang);

        try {
          const definitions = await vscode.commands.executeCommand<vscode.Location[]>(
            'vscode.executeDefinitionProvider',
            virtualUri,
            position
          );
          return definitions;
        } catch {
          return undefined;
        }
      },
    }
  );

  context.subscriptions.push(provider);
}

/**
 * Forward diagnostics from virtual documents back to the .rg file.
 * Only include diagnostics that fall within agent zone line ranges.
 */
export function setupDiagnosticForwarding(
  context: vscode.ExtensionContext,
  diagnosticCollection: vscode.DiagnosticCollection
): void {
  const listener = vscode.languages.onDidChangeDiagnostics(async (e) => {
    for (const uri of e.uris) {
      // We are interested in diagnostics on virtual embedded docs
      if (uri.scheme !== 'reagent-embedded') { continue; }

      const path = uri.path;
      const virtualMatch = path.match(/^(.+\.rg)\.virtual\.(ts|js|py|kt)$/);
      if (!virtualMatch) { continue; }

      const originalPath = virtualMatch[1];
      const originalUri = vscode.Uri.file(originalPath);

      // Read original to get zone mapping
      let originalText: string;
      try {
        const bytes = await vscode.workspace.fs.readFile(originalUri);
        originalText = new TextDecoder('utf-8').decode(bytes);
      } catch {
        continue;
      }

      const parsed = parseReagentDocument(originalText);
      const diags = vscode.languages.getDiagnostics(uri);

      // Filter: only keep diagnostics that fall within zone body lines
      const filtered = diags.filter(d => {
        return parsed.zones.some(z =>
          d.range.start.line >= z.bodyStartLine && d.range.start.line < z.bodyEndLine
        );
      });

      // Map filtered diagnostics to original URI
      const mapped = filtered.map(d => {
        return new vscode.Diagnostic(d.range, d.message, d.severity);
      });

      diagnosticCollection.set(originalUri, mapped);
    }
  });

  context.subscriptions.push(listener);
}
