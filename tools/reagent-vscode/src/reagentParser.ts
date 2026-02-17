/**
 * Lightweight parser that extracts agent zone regions and participant language
 * mappings from a Reagent (.rg) document.
 *
 * Detects two kinds of agent zones:
 * 1. Standalone zones: `RoleName { ... }` on their own line
 * 2. Hook zones: `onSend { ... }` / `onReceive { ... }` inside message props
 *    (language inferred from sender/receiver of the enclosing message step)
 */

export interface ParticipantInfo {
  name: string;
  lang: string; // "ts" | "js" | "py" | "kt"
}

export interface AgentZoneRegion {
  participantName: string;
  lang: string;
  /** 0-based line of the opening `Name {` or `onSend {` */
  startLine: number;
  /** 0-based line of the closing `}` */
  endLine: number;
  /** 0-based line where zone body content starts (after the `{`) */
  bodyStartLine: number;
  /** 0-based line where zone body content ends (before the `}`) */
  bodyEndLine: number;
  /** The raw text of the zone body (lines between { and }) */
  bodyText: string;
  /** Whether this is a hook zone (onSend/onReceive) */
  isHook: boolean;
}

export interface ParseResult {
  participants: ParticipantInfo[];
  zones: AgentZoneRegion[];
}

const PARTICIPANTS_RE = /^\s*participants\s*:\s*(.+)$/;
const PARTICIPANT_ENTRY_RE = /([A-Za-z_][A-Za-z0-9_\-\.]*)\s*\[(ts|js|py|kt)\]/g;

/**
 * Matches a line that opens a standalone agent zone: `AgentName {` at the end of a line.
 * Must NOT match protocol-level constructs.
 */
const ZONE_OPEN_RE = /^\s*([A-Za-z_][A-Za-z0-9_\-\.]*)\s*\{\s*$/;

/**
 * Matches a message step with props: `A --> B: MessageName = {`
 */
const MESSAGE_WITH_PROPS_RE = /^\s*([A-Za-z_][A-Za-z0-9_\-\.]*)\s*(-->>|->>|-->|->)\s*([A-Za-z_][A-Za-z0-9_\-\.]*)\s*:\s*[^=\n]+?\s*=\s*\{\s*$/;

/**
 * Matches a hook zone opener inside message props: `onSend {` or `onReceive {`
 */
const HOOK_ZONE_RE = /^\s*(onSend|onReceive)\s*\{\s*$/;

const PROTOCOL_KEYWORDS = new Set([
  'protocol', 'alt', 'loop', 'par', 'try', 'catch', 'else', 'wait', 'timeout', 'and',
  'import', 'if'
]);

/**
 * Find the matching closing brace starting from line `start` (which is the line
 * after the opening `{`). Returns the 0-based line of the `}`.
 */
function findClosingBrace(lines: string[], start: number): number {
  let depth = 1;
  let j = start;
  while (j < lines.length && depth > 0) {
    const line = lines[j];
    for (const ch of line) {
      if (ch === '{') { depth++; }
      if (ch === '}') { depth--; }
      if (depth === 0) { break; }
    }
    if (depth > 0) { j++; }
  }
  return j;
}

export function parseReagentDocument(text: string): ParseResult {
  const lines = text.split('\n');
  const participants: ParticipantInfo[] = [];
  const zones: AgentZoneRegion[] = [];

  // Build participant → lang mapping
  const langMap = new Map<string, string>();

  for (const line of lines) {
    const pm = PARTICIPANTS_RE.exec(line);
    if (pm) {
      let m: RegExpExecArray | null;
      PARTICIPANT_ENTRY_RE.lastIndex = 0;
      while ((m = PARTICIPANT_ENTRY_RE.exec(pm[1])) !== null) {
        const name = m[1];
        const lang = m[2];
        participants.push({ name, lang });
        langMap.set(name, lang);
      }
    }
  }

  // Find agent zones (standalone and hook zones)
  let i = 0;
  while (i < lines.length) {
    // Check for message step with props (to detect hook zones inside)
    const msgMatch = MESSAGE_WITH_PROPS_RE.exec(lines[i]);
    if (msgMatch) {
      const sender = msgMatch[1];
      const receiver = msgMatch[3];
      const msgStartLine = i;

      // Scan inside the message props block for onSend / onReceive hook zones
      let j = i + 1;
      const msgCloseLine = findClosingBrace(lines, j);

      while (j < msgCloseLine) {
        const hookMatch = HOOK_ZONE_RE.exec(lines[j]);
        if (hookMatch) {
          const hookType = hookMatch[1]; // "onSend" or "onReceive"
          const roleName = hookType === 'onSend' ? sender : receiver;
          const lang = langMap.get(roleName) || 'ts';
          const hookStartLine = j;
          const hookBodyStartLine = j + 1;
          const hookEndLine = findClosingBrace(lines, hookBodyStartLine);
          const hookBodyEndLine = hookEndLine;
          const bodyLines = lines.slice(hookBodyStartLine, hookBodyEndLine);

          zones.push({
            participantName: roleName,
            lang,
            startLine: hookStartLine,
            endLine: hookEndLine,
            bodyStartLine: hookBodyStartLine,
            bodyEndLine: hookBodyEndLine,
            bodyText: bodyLines.join('\n'),
            isHook: true,
          });

          j = hookEndLine + 1;
          continue;
        }
        j++;
      }

      i = msgCloseLine + 1;
      continue;
    }

    // Check for standalone agent zone
    const zm = ZONE_OPEN_RE.exec(lines[i]);
    if (zm) {
      const name = zm[1];
      if (!PROTOCOL_KEYWORDS.has(name) && langMap.has(name)) {
        const startLine = i;
        const bodyStartLine = i + 1;
        const endLine = findClosingBrace(lines, bodyStartLine);
        const bodyEndLine = endLine;
        const bodyLines = lines.slice(bodyStartLine, bodyEndLine);

        zones.push({
          participantName: name,
          lang: langMap.get(name) || 'ts',
          startLine,
          endLine,
          bodyStartLine,
          bodyEndLine,
          bodyText: bodyLines.join('\n'),
          isHook: false,
        });

        i = endLine + 1;
        continue;
      }
    }

    i++;
  }

  return { participants, zones };
}

/** Maps our lang tags to VS Code language IDs */
export function langTagToLanguageId(tag: string): string {
  switch (tag) {
    case 'ts': return 'typescript';
    case 'js': return 'javascript';
    case 'py': return 'python';
    case 'kt': return 'kotlin';
    default: return 'plaintext';
  }
}
