/**
 * Demo bootstrapper: boots the API with the in-memory user repo so it
 * runs without Postgres.
 *
 * Moved from `src/demo-server.ts` to `scripts/demo-server.ts` in rc.33
 * specifically to exclude it from the production build. The TS root
 * `"include": ["src/**\/*"]` in `tsconfig.json` no longer reaches this
 * file, so `dist/demo-server.js` does not exist in shipped images.
 * That prevents an operator from `node dist/demo-server.js`-ing a
 * working API that bypasses `assertProductionConfig()` and silently
 * stores every enrollment in-memory.
 *
 * Requires `VOUCHFLOW_READ_KEY` + `VOUCHFLOW_BASE_URL` to be set
 * (typically loaded from `apps/api/.env.local`).
 *
 * Usage (dev-only, against the .ts source via tsx):
 *   set -a; source apps/api/.env.local; set +a
 *   PORT=8080 npx tsx apps/api/scripts/demo-server.ts
 */
import { InMemoryUserRepo } from '../src/db/users.memory.js';
import { buildServer } from '../src/server.js';

const PORT = Number(process.env.PORT ?? 8080);

const app = await buildServer({
  userRepo: new InMemoryUserRepo(),
  logger: { level: 'info' },
  instanceId: 'demo-instance',
});

await app.listen({ port: PORT, host: '0.0.0.0' });
app.log.info(
  {
    base: process.env.VOUCHFLOW_BASE_URL,
  },
  'demo server ready',
);
