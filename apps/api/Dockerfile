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
EXPOSE 8080
CMD ["node", "apps/api/dist/server.js"]
