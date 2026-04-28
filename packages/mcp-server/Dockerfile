# syntax=docker/dockerfile:1.7

FROM node:22-alpine AS builder
WORKDIR /app

# Copy workspace manifests for cached install
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/mcp-server/package.json packages/mcp-server/

RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
RUN pnpm install --frozen-lockfile --filter mcp-server...

# Copy sources and build
COPY packages/mcp-server packages/mcp-server
RUN pnpm --filter mcp-server build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

COPY --from=builder /app/package.json /app/pnpm-workspace.yaml /app/pnpm-lock.yaml ./
COPY --from=builder /app/packages/mcp-server/package.json packages/mcp-server/
COPY --from=builder /app/packages/mcp-server/dist packages/mcp-server/dist
COPY --from=builder /app/packages/mcp-server/src/schema packages/mcp-server/dist/schema

RUN pnpm install --frozen-lockfile --filter mcp-server... --prod

EXPOSE 3333
CMD ["node", "packages/mcp-server/dist/index.js"]
