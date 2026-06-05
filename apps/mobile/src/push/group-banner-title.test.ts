import { describe, expect, it } from 'vitest';
import { resolveGroupBannerTitle } from './group-banner-title.js';

// The group banner top must name the ROOM, never one member — otherwise it
// duplicates the per-line sender inside MessagingStyle. See
// resolveGroupBannerTitle's doc + chloro's 2026-06-04 "@chloro shown twice".
describe('resolveGroupBannerTitle', () => {
  it('prefers a real local room name', () => {
    expect(resolveGroupBannerTitle('Poker Night', 'Poker Night', 'fuertechino')).toBe(
      'Poker Night',
    );
  });

  it('falls back to the server room name when there is no local name', () => {
    expect(resolveGroupBannerTitle(undefined, 'Poker Night', 'fuertechino')).toBe('Poker Night');
  });

  it('rejects a local name that is just the sender handle (with @)', () => {
    // The degenerate case from the field: an unnamed room locally named
    // "@chloro" must NOT surface as the title.
    expect(resolveGroupBannerTitle('@chloro', undefined, 'chloro')).toBe('speakeasy');
  });

  it('rejects a local name that is the bare sender handle (no @)', () => {
    expect(resolveGroupBannerTitle('chloro', undefined, 'chloro')).toBe('speakeasy');
  });

  it('rejects a sender-handle local name but still uses a real server name', () => {
    expect(resolveGroupBannerTitle('@chloro', 'Poker Night', 'chloro')).toBe('Poker Night');
  });

  it('rejects a server title that is just the sender handle', () => {
    expect(resolveGroupBannerTitle(undefined, '@chloro', 'chloro')).toBe('speakeasy');
  });

  it('uses the local "Room with @…" fallback name verbatim (not a bare handle)', () => {
    expect(
      resolveGroupBannerTitle('Room with @speaker, @fuertechino', undefined, 'speaker'),
    ).toBe('Room with @speaker, @fuertechino');
  });

  it('returns the neutral label when nothing usable is available', () => {
    expect(resolveGroupBannerTitle(undefined, undefined, 'chloro')).toBe('speakeasy');
    expect(resolveGroupBannerTitle('', '', 'chloro')).toBe('speakeasy');
  });

  it('derives a "Room with @…" label from members when no name reached this device', () => {
    expect(
      resolveGroupBannerTitle(undefined, undefined, 'bananaman6', {
        members: ['lunchbox', 'bananaman6', 'fuertechino'],
        selfId: 'lunchbox',
      }),
    ).toBe('Room with @bananaman6, @fuertechino');
  });

  it('prefers a real name over the member-derived fallback', () => {
    expect(
      resolveGroupBannerTitle('Suckdix', undefined, 'bananaman6', {
        members: ['lunchbox', 'bananaman6'],
        selfId: 'lunchbox',
      }),
    ).toBe('Suckdix');
  });

  it('caps the derived label at 3 members', () => {
    expect(
      resolveGroupBannerTitle(undefined, undefined, 'x', {
        members: ['a', 'b', 'c', 'd', 'e'],
        selfId: 'self',
      }),
    ).toBe('Room with @a, @b, @c');
  });
});
