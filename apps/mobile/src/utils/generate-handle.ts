/**
 * RN-side handle generator for the onboarding "Generate one for me"
 * button. Picks from three curated short-word lists so the
 * `<adj1>-<adj2>-<noun>` triple stays under the 20-char handle ceiling
 * (six chars + six chars + six chars + two hyphens = 20).
 *
 * The server-side `generateUserId` in `@speakeasy/shared/ids/generate`
 * uses `node:crypto` + the full 16k-word lists; that path can't run in
 * Hermes. Mobile uses Math.random + a small inline list — quality
 * doesn't matter for handle generation, only that the user can re-roll
 * cheaply, and small lists give better "memorable" output anyway.
 *
 * Curation notes (per ONBOARDING.md §3):
 *  - 4–6 letters per word (4-letter words add variety; 6 keeps the
 *    triple under cap reliably).
 *  - No personal names / brands / pop-culture.
 *  - First adjective biased toward color / temperature; second toward
 *    state / mood — gives generated handles a consistent rhythm.
 *  - Each list ran through a multilingual profanity filter at curation
 *    time. Anything questionable was dropped on close calls.
 */

const ADJECTIVES_1 = [
  // color / temperature / texture
  'amber', 'ash', 'bone', 'brass', 'cedar', 'clay', 'cocoa',
  'cool', 'copper', 'cream', 'dim', 'dusk', 'dusty', 'ember',
  'frost', 'glow', 'gold', 'green', 'grey', 'ink', 'iris',
  'ivory', 'jade', 'jet', 'lake', 'lilac', 'lime', 'mauve',
  'mint', 'moss', 'navy', 'neon', 'olive', 'pale', 'paper',
  'pearl', 'plum', 'rain', 'red', 'rose', 'rust', 'sable',
  'salt', 'sand', 'sepia', 'shade', 'silk', 'sky', 'slate',
  'sleet', 'smoke', 'snow', 'soft', 'sun', 'tan', 'teal',
  'twig', 'umber', 'warm', 'white', 'wood',
] as const;

const ADJECTIVES_2 = [
  // state / mood / shape
  'awake', 'bare', 'big', 'blank', 'blunt', 'bold', 'bound',
  'brave', 'brisk', 'calm', 'clear', 'crisp', 'deep', 'eager',
  'easy', 'edge', 'even', 'far', 'firm', 'fond', 'free',
  'gentle', 'glad', 'good', 'grand', 'happy', 'high', 'idle',
  'just', 'keen', 'kind', 'late', 'lean', 'light', 'long',
  'low', 'meek', 'mute', 'new', 'odd', 'open', 'pure',
  'quick', 'quiet', 'rapid', 'rare', 'ready', 'rough', 'safe',
  'sharp', 'short', 'shy', 'silent', 'slow', 'small', 'smart',
  'still', 'strong', 'swift', 'tall', 'tame', 'thin', 'tidy',
  'tiny', 'wild', 'wise', 'young',
] as const;

const NOUNS = [
  // animals / places / objects (no personal references)
  'arch', 'bay', 'beach', 'bell', 'bench', 'bird', 'book',
  'breeze', 'brook', 'cabin', 'cape', 'cave', 'cedar', 'cliff',
  'cloud', 'coast', 'cove', 'creek', 'dawn', 'desk', 'dock',
  'dove', 'dune', 'dusk', 'echo', 'fern', 'field', 'finch',
  'fjord', 'flame', 'fog', 'forge', 'fox', 'frame', 'fern',
  'gale', 'glade', 'grove', 'gull', 'harbor', 'hawk', 'haze',
  'heath', 'heron', 'hill', 'hush', 'isle', 'kite', 'lake',
  'lane', 'leaf', 'loft', 'lynx', 'maple', 'marsh', 'meadow',
  'mist', 'moon', 'moss', 'moth', 'oak', 'oasis', 'orchid',
  'otter', 'owl', 'path', 'peak', 'pier', 'pine', 'plain',
  'pond', 'port', 'prairie', 'quay', 'raven', 'reef', 'ridge',
  'river', 'road', 'rock', 'rook', 'sand', 'sky', 'snow',
  'sound', 'spring', 'stag', 'star', 'stone', 'storm', 'stream',
  'swift', 'thorn', 'tide', 'trail', 'trout', 'twig', 'valley',
  'vine', 'wave', 'wharf', 'whale', 'willow', 'wind', 'wing',
  'wolf', 'wood',
] as const;

function pick<T extends readonly string[]>(list: T): string {
  return list[Math.floor(Math.random() * list.length)]!;
}

const HANDLE_MAX = 20;

/**
 * Generate a memorable `<adj1>-<adj2>-<noun>` handle that fits the
 * 20-character handle ceiling. Retries silently when a triple lands
 * over the cap (rare with the curated 4-6 letter lists, but the
 * inclusion of 7-char words like `silent`, `meadow`, `prairie` makes
 * occasional rerolls necessary).
 */
export function generateShortHandle(): string {
  // 50 attempts is more than enough — average curated word length is
  // ~5 chars, so > 20-char triples are <1% of draws. Throws only if
  // the lists have been catastrophically mis-edited.
  for (let i = 0; i < 50; i++) {
    const candidate = `${pick(ADJECTIVES_1)}-${pick(ADJECTIVES_2)}-${pick(NOUNS)}`;
    if (candidate.length <= HANDLE_MAX) return candidate;
  }
  // Fallback — should never hit. Pick a known-short combo.
  return 'amber-quiet-fox';
}
