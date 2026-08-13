import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(__dirname, 'push-handler.ts'), 'utf8');

describe('background push delivery acknowledgement safety', () => {
  it('does not acknowledge a ciphertext-less attachment banner', () => {
    const attachmentBranch = source.slice(
      source.indexOf('// Rich device + a message push carrying a sender but NO ciphertext'),
      source.indexOf('// Calls get the full-screen ringing notification'),
    );

    expect(attachmentBranch).not.toContain('ackDeliveredHeadless');
  });

  it('only acknowledges a decryptable push after durable inbox persistence', () => {
    expect(source).toContain('let persistedForForeground = false;');
    expect(source).toContain('persistedForForeground = true;');
    expect(source).toContain('if (persistedForForeground) {');
  });
});
