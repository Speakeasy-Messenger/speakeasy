import { describe, expect, it } from 'vitest';
import { tokenize } from './rich-message-text.js';

describe('tokenize', () => {
  it('returns a single plain segment for text with no links/mentions', () => {
    expect(tokenize('hello world', false)).toEqual([
      { kind: 'plain', text: 'hello world' },
    ]);
  });

  it('detects an https URL', () => {
    expect(tokenize('see https://example.com now', false)).toEqual([
      { kind: 'plain', text: 'see ' },
      { kind: 'link', text: 'https://example.com', url: 'https://example.com' },
      { kind: 'plain', text: ' now' },
    ]);
  });

  it('upgrades a bare www. link to https', () => {
    expect(tokenize('www.example.com', false)).toEqual([
      {
        kind: 'link',
        text: 'www.example.com',
        url: 'https://www.example.com',
      },
    ]);
  });

  it('leaves trailing sentence punctuation out of the link', () => {
    expect(tokenize('go to https://example.com.', false)).toEqual([
      { kind: 'plain', text: 'go to ' },
      { kind: 'link', text: 'https://example.com', url: 'https://example.com' },
      { kind: 'plain', text: '.' },
    ]);
  });

  it('detects mentions only when withMentions is set', () => {
    expect(tokenize('hi @fox', false)).toEqual([
      { kind: 'plain', text: 'hi @fox' },
    ]);
    expect(tokenize('hi @fox', true)).toEqual([
      { kind: 'plain', text: 'hi ' },
      { kind: 'mention', text: '@fox' },
    ]);
  });

  it('handles a link and a mention in the same message', () => {
    expect(tokenize('@fox check https://x.com', true)).toEqual([
      { kind: 'mention', text: '@fox' },
      { kind: 'plain', text: ' check ' },
      { kind: 'link', text: 'https://x.com', url: 'https://x.com' },
    ]);
  });
});
