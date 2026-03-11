import * as vscode from 'vscode';

let channel: vscode.OutputChannel | null = null;

function getChannel(): vscode.OutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel('Reagent Debug Protocol');
  }
  return channel;
}

export function showDebugProtocolLog(preserveFocus = true): void {
  getChannel().show(preserveFocus);
}

export function logDebugProtocol(message: string, payload?: unknown): void {
  const ch = getChannel();
  const time = new Date().toLocaleTimeString();
  ch.appendLine(`[${time}] ${message}`);
  if (payload !== undefined) {
    try {
      ch.appendLine(JSON.stringify(payload, null, 2));
    } catch {
      ch.appendLine(String(payload));
    }
  }
}
