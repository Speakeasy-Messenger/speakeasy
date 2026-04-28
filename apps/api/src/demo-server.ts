/**
 * Demo bootstrapper: boots the API with the in-memory user repo so it runs
 * without Postgres.
 *
 * - With `VOUCHFLOW_READ_KEY` + `VOUCHFLOW_BASE_URL` set (typically loaded
 *   from `apps/api/.env.local`), uses the real VouchflowValidator and hits
 *   `sandbox.api.vouchflow.dev`.
 * - With `VOUCHFLOW_USE_MOCK=1`, uses MockValidator (every deviceToken
 *   passes). Useful for offline demos.
 *
 * Usage:
 *   set -a; source apps/api/.env.local; set +a
 *   PORT=8080 node apps/api/dist/demo-server.js
 */
import { InMemoryUserRepo } from './db/users.memory.js';
import { buildServer } from './server.js';

const PORT = Number(process.env.PORT ?? 8080);

const app = await buildServer({
  // validator omitted → defaultValidator() uses env (real or mock per env vars).
  userRepo: new InMemoryUserRepo(),
  logger: { level: 'info' },
  instanceId: 'demo-instance',
});

await app.listen({ port: PORT, host: '127.0.0.1' });
app.log.info(
  {
    mode: process.env.VOUCHFLOW_USE_MOCK === '1' ? 'mock' : 'live-vouchflow',
    base: process.env.VOUCHFLOW_BASE_URL,
  },
  'demo server ready',
);
