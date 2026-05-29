/**
 * Demo bootstrapper: boots the API with the in-memory user repo so it runs
 * without Postgres.
 *
 * Requires `VOUCHFLOW_READ_KEY` + `VOUCHFLOW_BASE_URL` to be set
 * (typically loaded from `apps/api/.env.local`).
 *
 * Usage:
 *   set -a; source apps/api/.env.local; set +a
 *   PORT=8080 node apps/api/dist/demo-server.js
 */
import { InMemoryUserRepo } from './db/users.memory.js';
import { buildServer } from './server.js';

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
