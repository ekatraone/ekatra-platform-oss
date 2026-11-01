# Build the application and its declared workspace dependencies.
FROM node:22.18.0-alpine AS builder
WORKDIR /app
RUN npm install -g pnpm@10.28.1

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/worker/package.json ./apps/worker/
COPY packages/database/package.json ./packages/database/
COPY packages/messaging/package.json ./packages/messaging/
COPY packages/delivery/package.json ./packages/delivery/
RUN pnpm install --frozen-lockfile

COPY apps/worker ./apps/worker
COPY packages ./packages
RUN pnpm --filter @ekatra/worker... build
RUN pnpm --filter @ekatra/worker deploy --legacy --prod /release

FROM node:22.18.0-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder --chown=node:node /release ./
USER node

CMD ["node", "dist/index.js"]
