# Fly.io infrastructure

Three apps make up the Speakeasy backend on Fly:

| App                | Purpose                | Provisioning                                              |
| ------------------ | ---------------------- | --------------------------------------------------------- |
| `speakeasy-api`    | Fastify + WebSocket    | `flyctl deploy --config infra/fly/api.toml`               |
| `speakeasy-db`     | Managed Postgres       | `flyctl postgres create --name speakeasy-db`              |
| `speakeasy-redis`  | Managed Upstash Redis  | `flyctl redis create --name speakeasy-redis`              |

After Postgres and Redis exist, attach them to the API so the URLs are
injected as secrets:

```sh
flyctl postgres attach speakeasy-db --app speakeasy-api
flyctl redis status speakeasy-redis    # copy URL → flyctl secrets set REDIS_URL=...
```

AWS migration trigger (per spec §7): unpredictable Postgres tier jumps, or
SOC2/HIPAA enterprise compliance requirements. The Dockerfile + `node:20-alpine`
base image keeps that migration mechanical.

## Phase 4 production hardening

**Secrets to set on first deploy** (`flyctl secrets set ... --app speakeasy-api`):

| Secret                          | Source                                       |
| ------------------------------- | -------------------------------------------- |
| `VOUCHFLOW_READ_KEY`            | Vouchflow dashboard, read-scoped key         |
| `VOUCHFLOW_BASE_URL`            | `https://api.vouchflow.dev/v1` (live)        |
| `INSTANCE_ID`                   | optional; per-machine via `flyctl machine env` |

`DATABASE_URL` and `REDIS_URL` are populated by the `attach` commands above.

**Volume snapshots** (Postgres):

```sh
# One-shot snapshot
flyctl postgres backup create --app speakeasy-db

# Restore from snapshot
flyctl postgres backup list --app speakeasy-db
flyctl postgres backup restore <id> --app speakeasy-db
```

Daily snapshots are retained automatically by Fly's managed Postgres; verify
with `flyctl postgres backup list`. For higher RPO/RTO requirements, add a
nightly logical dump to S3 via a Fly cron app (deferred — Phase 5).

**Operational invariants** (Phase 4):

- `min_machines_running = 2` so cross-instance Redis pub/sub for ack
  routing always has a peer when one machine restarts during a deploy.
- `auto_stop_machines = false` — WS pools and Vouchflow caches are
  warm-state we don't want to lose to autostop.
- Health check `restart_limit = 3` — three consecutive failures triggers
  a restart of the unhealthy machine before Fly removes it from rotation.
