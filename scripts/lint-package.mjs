import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const pkg = process.argv[2];

const packageRoots = {
  '@speakeasy/api': ['apps/api/src'],
  '@speakeasy/mobile': ['apps/mobile/src'],
  '@speakeasy/crypto': ['packages/crypto/src'],
  '@speakeasy/shared': ['packages/shared/src'],
  '@speakeasy/vouchflow': ['packages/vouchflow/src'],
};

const consoleAllowlist = new Set([
  'apps/api/src/ws/load-test.ts',
  'apps/api/src/server.ts',
]);

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(path, out);
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      out.push(path);
    }
  }
  return out;
}

function previousLineAllowsConsole(lines, index) {
  const prev = lines[index - 1] ?? '';
  return prev.includes('eslint-disable-next-line no-console');
}

function checkConsole(paths) {
  const failures = [];
  for (const file of paths) {
    const rel = relative(root, file);
    if (consoleAllowlist.has(rel)) continue;
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, index) => {
      if (line.includes('console.') && !previousLineAllowsConsole(lines, index)) {
        failures.push(`${rel}:${index + 1}: raw console.* requires explicit allowlist`);
      }
    });
  }
  return failures;
}

function checkMigrations() {
  const failures = [];
  const infraDir = join(root, 'infra/migrations');
  const migrations = readdirSync(infraDir)
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort();
  migrations.forEach((name, index) => {
    const expected = String(index + 1).padStart(4, '0');
    if (!name.startsWith(`${expected}_`)) {
      failures.push(`infra/migrations: expected ${expected}_*.sql, found ${name}`);
    }
  });
  const drizzleReadme = join(root, 'apps/api/drizzle/README.md');
  if (!existsSync(drizzleReadme)) {
    failures.push('apps/api/drizzle/README.md must declare infra/migrations as production source of truth');
  } else {
    const text = readFileSync(drizzleReadme, 'utf8');
    if (!text.includes('infra/migrations') || !text.includes('production source of truth')) {
      failures.push('apps/api/drizzle/README.md must document that infra/migrations is the production source of truth');
    }
  }
  return failures;
}

const roots = packageRoots[pkg];
if (!roots) {
  console.error(`Unknown package for lint: ${pkg}`);
  process.exit(1);
}

const files = roots.flatMap((dir) => walk(join(root, dir)));
const failures = [...checkConsole(files)];
if (pkg === '@speakeasy/api') failures.push(...checkMigrations());

if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}
