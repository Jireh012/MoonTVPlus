# syntax=docker/dockerfile:1
# 依赖层只跟 package.json / lockfile 走。改业务代码时不会重装 ffmpeg，也不会重编译 better-sqlite3。

FROM node:24.20.0-alpine AS deps

RUN corepack enable && corepack prepare pnpm@10.14.0 --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml ./

RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store \
 && pnpm config set registry https://registry.npmmirror.com \
 && pnpm install --frozen-lockfile --ignore-scripts

FROM node:24.20.0-alpine AS prod-deps

RUN corepack enable && corepack prepare pnpm@10.14.0 --activate \
 && sed -i 's#https://dl-cdn.alpinelinux.org#https://mirrors.cloud.tencent.com#g' /etc/apk/repositories \
 && apk add --no-cache python3 make g++

WORKDIR /app

COPY package.json pnpm-lock.yaml ./

# 预编译包下不到时，用国内 Node 头文件地址编译 better-sqlite3
ENV npm_config_disturl=https://npmmirror.com/mirrors/node

RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store \
 && pnpm config set registry https://registry.npmmirror.com \
 && pnpm install --frozen-lockfile --prod

FROM node:24.20.0-alpine AS builder

RUN corepack enable && corepack prepare pnpm@10.14.0 --activate

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

ENV DOCKER_ENV=true

RUN --mount=type=cache,id=next-cache,target=/app/.next/cache \
    pnpm run build

FROM node:24.20.0-alpine AS runner

RUN sed -i 's#https://dl-cdn.alpinelinux.org#https://mirrors.cloud.tencent.com#g' /etc/apk/repositories \
 && apk add --no-cache su-exec ffmpeg \
 && addgroup -g 1001 -S nodejs && adduser -u 1001 -S nextjs -G nodejs

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

WORKDIR /app
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
ENV DOCKER_ENV=true
ENV SQLITE_DB_PATH=/app/.data/moontv.db
ENV OFFLINE_DOWNLOAD_DIR=/data
ENV FFMPEG_PATH=/usr/bin/ffmpeg

COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/scripts ./scripts
COPY --from=builder --chown=nextjs:nodejs /app/migrations ./migrations
COPY --from=builder --chown=nextjs:nodejs /app/start.js ./start.js
COPY --from=builder --chown=nextjs:nodejs /app/server.js ./server.js
# 自定义 server.js 在运行时会 require('./src/lib/tv-remote-hub.js')。
# Next standalone 不会自动带上这个文件。
COPY --from=builder --chown=nextjs:nodejs /app/src/lib/tv-remote-hub.js ./src/lib/tv-remote-hub.js
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=prod-deps --chown=nextjs:nodejs /app/node_modules ./node_modules

RUN mkdir -p /app/.data "$OFFLINE_DOWNLOAD_DIR" \
  && chown -R nextjs:nodejs /app/.data "$OFFLINE_DOWNLOAD_DIR"

EXPOSE 3000

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "start.js"]
