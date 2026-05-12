/**
 * Tokenizer for the system-message brand-punctuation pattern
 * (CONVERSATIONS.md §3.6). Two patterns get a brass label:
 *
 *  - The leading `@` of every `@handle` token
 *  - The trailing `.` of the message
 *
 * Anything else stays in the muted body color.
 *
 * Lives in its own pure-TS file so the unit tests can import it
 * under the node-environment vitest harness without dragging in
 * the parent `.tsx` component (which imports `react-native`).
 */

export interface Segment {
  text: string;
  brass: boolean;
}

export function renderSegments(input: string): Segment[] {
  const pieces: Segment[] = [];
  // Spec handle pattern: `[a-z0-9._-]`. Case-insensitive flag in
  // case the message string slipped through with mixed case.
  const handleRe = /@[a-z0-9._-]+/gi;
  let cursor = 0;
  let m: RegExpExecArray | null;
  while ((m = handleRe.exec(input)) !== null) {
    if (m.index > cursor) {
      pieces.push({ text: input.slice(cursor, m.index), brass: false });
    }
    pieces.push({ text: '@', brass: true });
    pieces.push({ text: m[0].slice(1), brass: false });
    cursor = m.index + m[0].length;
  }
  if (cursor < input.length) {
    pieces.push({ text: input.slice(cursor), brass: false });
  }

  // Brass-tail the trailing period.
  if (pieces.length > 0) {
    const last = pieces[pieces.length - 1]!;
    if (!last.brass && last.text.endsWith('.')) {
      const trimmed = last.text.slice(0, -1);
      pieces[pieces.length - 1] = { text: trimmed, brass: false };
      pieces.push({ text: '.', brass: true });
    }
  }
  return pieces;
}
