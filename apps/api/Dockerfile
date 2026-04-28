FROM node:20-alpine AS builder
WORKDIR /repo

COPY package.json package-lock.json* turbo.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
RUN npm ci --ignore-scripts

COPY packages/shared packages/shared
COPY apps/api apps/api
RUN npm run build -w @speakeasy/shared
RUN npm run build -w @speakeasy/api

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /repo/node_modules ./node_modules
COPY --from=builder /repo/packages/shared/dist ./packages/shared/dist
COPY --from=builder /repo/packages/shared/package.json ./packages/shared/package.json
COPY --from=builder /repo/apps/api/dist ./apps/api/dist
COPY --from=builder /repo/apps/api/package.json ./apps/api/package.json

ENV PORT=8080
EXPOSE 8080
CMD ["node", "apps/api/dist/server.js"]
