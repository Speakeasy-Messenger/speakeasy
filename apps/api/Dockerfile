FROM node:20-alpine AS builder
WORKDIR /repo

COPY package.json package-lock.json* turbo.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/vouchflow/package.json packages/vouchflow/
COPY packages/crypto/package.json packages/crypto/
COPY apps/api/package.json apps/api/
RUN npm ci --ignore-scripts

COPY packages/shared packages/shared
COPY packages/vouchflow packages/vouchflow
COPY packages/crypto packages/crypto
COPY apps/api apps/api
RUN npm run build -w @speakeasy/shared
RUN npm run build -w @speakeasy/vouchflow
RUN npm run build -w @speakeasy/crypto
RUN npm run build -w @speakeasy/api

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /repo/node_modules ./node_modules
COPY --from=builder /repo/packages/shared/dist ./packages/shared/dist
COPY --from=builder /repo/packages/shared/package.json ./packages/shared/package.json
COPY --from=builder /repo/packages/vouchflow/dist ./packages/vouchflow/dist
COPY --from=builder /repo/packages/vouchflow/package.json ./packages/vouchflow/package.json
COPY --from=builder /repo/packages/crypto/dist ./packages/crypto/dist
COPY --from=builder /repo/packages/crypto/package.json ./packages/crypto/package.json
COPY --from=builder /repo/apps/api/dist ./apps/api/dist
COPY --from=builder /repo/apps/api/package.json ./apps/api/package.json

# `npm run db:migrate` (Fly's release_command) reads its script from
# the root package.json and migration SQL from infra/migrations/.
# Both must exist in the runner image — release_command runs a
# separate one-off VM off the runner image, not the builder.
COPY --from=builder /repo/package.json ./package.json
COPY infra/migrations ./infra/migrations

ENV PORT=8080

# Bake the git SHA into the image at build time so `/version` truthfully
# reports the running code's commit, with no possibility of a stale
# `flyctl secrets set GIT_SHA=...` drifting from the actual rolled
# image. CI passes `--build-arg GIT_SHA=$GITHUB_SHA`; local
# `flyctl deploy` callers can pass `--build-arg GIT_SHA=$(git rev-parse HEAD)`
# or omit it (falls back to "unknown", which is fine for ad-hoc deploys).
# Read by getVersion() at runtime — see apps/api/src/server.ts.
ARG GIT_SHA=unknown
ENV GIT_SHA=${GIT_SHA}

EXPOSE 8080
CMD ["node", "apps/api/dist/server.js"]
