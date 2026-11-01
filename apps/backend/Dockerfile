# Build the application and its declared workspace dependencies.
FROM node:22.18.0-alpine AS builder
WORKDIR /app
RUN npm install -g pnpm@10.28.1

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/backend/package.json ./apps/backend/
COPY packages/database/package.json ./packages/database/
COPY packages/messaging/package.json ./packages/messaging/
COPY packages/delivery/package.json ./packages/delivery/
RUN pnpm install --frozen-lockfile

COPY apps/backend ./apps/backend
COPY packages ./packages
RUN pnpm --filter @ekatra/backend... build
RUN pnpm --filter @ekatra/backend deploy --legacy --prod /release

FROM node:22.18.0-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder --chown=node:node /release ./
USER node
ENV PORT=3000
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health/ready || exit 1

CMD ["node", "dist/index.js"]
