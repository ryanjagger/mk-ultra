# ---- build: pnpm workspace -> bundled server + static client ----
FROM node:22-alpine AS build
WORKDIR /app
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/sim/package.json packages/sim/
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/client/package.json packages/client/
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm -r build

# ---- runtime: single bundled file + static assets, no node_modules ----
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/packages/server/dist/index.cjs ./server.cjs
COPY --from=build /app/packages/client/dist ./public
ENV CLIENT_DIST=/app/public
# leaderboards persist to DATA_DIR; Railway mounts a durable volume here in
# production, and this gives local `docker run` the same path (anon volume)
ENV DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 8080
CMD ["node", "server.cjs"]
