import { describe, expect, it } from 'vitest';
import { redactToken } from './redact.js';

describe('redactToken', () => {
  it('returns <none> for missing tokens', () => {
    expect(redactToken(undefined)).toBe('<none>');
    expect(redactToken(null)).toBe('<none>');
    expect(redactToken('')).toBe('<none>');
  });

  it('never echoes the full token', () => {
    const token = 'dvt_live_abcdefghijklmnopqrstuvwxyz0123456789';
    const redacted = redactToken(token);
    expect(redacted).not.toContain('abcdefghij');
    expect(redacted).not.toBe(token);
  });

  it('keeps only a short tail for correlation', () => {
    expect(redactToken('dvt_live_abcdef123456')).toBe('…123456 (len 21)');
  });

  it('does not preview tokens at or below the tail length', () => {
    expect(redactToken('short')).toBe('<redacted> (len 5)');
    expect(redactToken('abcdef')).toBe('<redacted> (len 6)');
  });

  it('is stable — the same token redacts identically (correlation)', () => {
    const t = 'dvt_live_zzzzzzzzzzzz999999';
    expect(redactToken(t)).toBe(redactToken(t));
  });
});
