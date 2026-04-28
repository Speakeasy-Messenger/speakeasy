import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

function loadList(filename: string): readonly string[] {
  const raw = readFileSync(join(here, filename), 'utf8');
  const words = raw
    .split('\n')
    .map((w) => w.trim())
    .filter((w) => w.length > 0);
  return Object.freeze(words);
}

export const ADJECTIVES = loadList('adjectives.txt');
export const NOUNS = loadList('nouns.txt');
