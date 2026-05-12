import { describe, expect, it } from 'vitest';
import {
  renderSegments,
  type Segment,
} from './system-message-segments.js';

/**
 * Pure-function tests for the system-message tokenizer. The brass
 * accents are the brand-punctuation pattern (CONVERSATIONS.md §3.6),
 * so getting these wrong shows up as visibly off-brand text.
 */

const flat = (segs: Segment[]): string => segs.map((s) => s.text).join('');
const brassChunks = (segs: Segment[]): string[] =>
  segs.filter((s) => s.brass).map((s) => s.text);
const muteChunks = (segs: Segment[]): string[] =>
  segs.filter((s) => !s.brass).map((s) => s.text);

describe('renderSegments', () => {
  it('round-trips plain text without segments', () => {
    const segs = renderSegments('hello there');
    expect(flat(segs)).toBe('hello there');
    expect(brassChunks(segs)).toEqual([]);
  });

  it('brass-tails a trailing period', () => {
    const segs = renderSegments('messages now leave in 24h.');
    expect(flat(segs)).toBe('messages now leave in 24h.');
    expect(brassChunks(segs)).toEqual(['.']);
    expect(muteChunks(segs)).toEqual(['messages now leave in 24h']);
  });

  it('does not synthesize a period when none is present', () => {
    const segs = renderSegments('messages now leave in 24h');
    expect(flat(segs)).toBe('messages now leave in 24h');
    expect(brassChunks(segs)).toEqual([]);
  });

  it('marks the leading @ of a handle as brass and keeps the body muted', () => {
    const segs = renderSegments('you blocked @amber.');
    expect(flat(segs)).toBe('you blocked @amber.');
    expect(brassChunks(segs)).toEqual(['@', '.']);
    expect(muteChunks(segs)).toEqual(['you blocked ', 'amber']);
  });

  it('handles multiple @-handles in one message', () => {
    const segs = renderSegments('@bento removed @kim.');
    expect(flat(segs)).toBe('@bento removed @kim.');
    // Two brass `@` glyphs + the trailing brass period.
    expect(brassChunks(segs)).toEqual(['@', '@', '.']);
    expect(muteChunks(segs)).toEqual(['bento', ' removed ', 'kim']);
  });

  it("matches handle bodies with the spec's character set", () => {
    // Spec handle pattern: lowercase letters, digits, dot, dash,
    // underscore. The handle's regex itself swallows mid-handle
    // dots — the trailing `.` here belongs to the message, not the
    // handle, so it gets brass-tailed separately.
    const segs = renderSegments('@a1.b-c_d.');
    expect(brassChunks(segs)).toContain('@');
    expect(brassChunks(segs)).toContain('.');
    expect(muteChunks(segs).join('')).toBe('a1.b-c_d');
  });

  it('renders the post-call system message with the duration colon untouched', () => {
    // `voice call · 4:38.` — the colon inside the duration is body
    // text, not part of any handle. Only the trailing period gets
    // brass.
    const segs = renderSegments('voice call · 4:38.');
    expect(flat(segs)).toBe('voice call · 4:38.');
    expect(brassChunks(segs)).toEqual(['.']);
  });

  it('renders the missed-call system message correctly', () => {
    const segs = renderSegments('@amber called. you missed it.');
    expect(flat(segs)).toBe('@amber called. you missed it.');
    // Only the FINAL `.` becomes brass; the middle one stays in the
    // muted body. Two brass tokens total: the `@` and the tail `.`.
    expect(brassChunks(segs)).toEqual(['@', '.']);
    expect(muteChunks(segs)).toContain('amber');
    expect(muteChunks(segs).join('')).toContain(' called. you missed it');
  });

  it('returns an empty list for empty input', () => {
    expect(renderSegments('')).toEqual([]);
  });

  it('handles a message that is just a handle', () => {
    const segs = renderSegments('@bento');
    expect(flat(segs)).toBe('@bento');
    expect(brassChunks(segs)).toEqual(['@']);
    expect(muteChunks(segs)).toEqual(['bento']);
  });
});
