# Build stage
FROM node:22-alpine AS builder

WORKDIR /app

RUN npm install -g pnpm

# Copy package manifests
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/worker/package.json ./apps/worker/
COPY packages/database/package.json ./packages/database/
COPY packages/messaging/package.json ./packages/messaging/

RUN pnpm install --frozen-lockfile

# Copy source
COPY apps/worker ./apps/worker
# Worker imports CourseDeliveryService from backend via relative path
COPY apps/backend/src ./apps/backend/src
COPY apps/backend/package.json ./apps/backend/
COPY apps/backend/tsconfig.json ./apps/backend/
COPY packages ./packages

# Build packages and worker (backend src is needed for CourseDeliveryService import)
RUN pnpm --filter @ekatra/database build
RUN pnpm --filter @ekatra/messaging build
RUN pnpm --filter @ekatra/backend build
RUN pnpm --filter @ekatra/worker build

# Production stage
FROM node:22-alpine AS runner

WORKDIR /app

RUN npm install -g pnpm

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/worker/package.json ./apps/worker/
COPY packages/database/package.json ./packages/database/
COPY packages/messaging/package.json ./packages/messaging/

RUN pnpm install --frozen-lockfile --prod

COPY --from=builder /app/apps/worker/dist ./apps/worker/dist
COPY --from=builder /app/apps/backend/dist ./apps/backend/dist
COPY --from=builder /app/packages/database/dist ./packages/database/dist
COPY --from=builder /app/packages/messaging/dist ./packages/messaging/dist

ENV NODE_ENV=production

CMD ["node", "apps/worker/dist/index.js"]
