/**
 * Server-only ID generation. Lives in a separate subpath because it
 * pulls in `node:crypto` and the wordlists (`node:fs`), neither of
 * which is available in the React Native runtime. Mobile uses the
 * regex validators in `./index.js` instead — actual user IDs are
 * minted by the server at enrollment time.
 *
 * Import via the dedicated subpath:
 *   import { generateUserId } from '@speakeasy/shared/ids/generate';
 */

import { randomInt } from 'node:crypto';
import { ADJECTIVES, NOUNS } from '../wordlists/index.js';

/**
 * Generate a candidate legacy user ID in `adjective-adjective-noun`
 * form. New enrollment goes through `HANDLE_REGEX` (user-picked
 * single-token handle) — this generator is retained for legacy
 * pre-handle-cutover code paths only. Server must verify uniqueness
 * against the users table before issuing.
 */
export function generateUserId(): string {
  const adj1 = ADJECTIVES[randomInt(ADJECTIVES.length)]!;
  const adj2 = ADJECTIVES[randomInt(ADJECTIVES.length)]!;
  const noun = NOUNS[randomInt(NOUNS.length)]!;
  return `${adj1}-${adj2}-${noun}`;
}

export const ID_SPACE_SIZE = ADJECTIVES.length * ADJECTIVES.length * NOUNS.length;
