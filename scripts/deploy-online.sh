#!/bin/sh
# 把当前工作区构建到 124.223.169.235 并替换 moontv-core。
# 数据目录 /root/moontvplus/data 不在构建上下文里，不会被覆盖。
set -eu

HOST="${DEPLOY_HOST:-root@124.223.169.235}"
KEY="${DEPLOY_KEY:-$HOME/.ssh/id_ed25519_192.168.1.142}"
ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
SSH="ssh -i $KEY -o IdentitiesOnly=yes -o BatchMode=yes"

$SSH "$HOST" 'mkdir -p /root/moontvplus/src'
tar czf - \
  --exclude node_modules \
  --exclude .next \
  --exclude .data \
  --exclude .git \
  --exclude .env \
  --exclude .env.local \
  --exclude apps \
  -C "$ROOT" . \
  | $SSH "$HOST" 'tar xzf - -C /root/moontvplus/src'

$SSH "$HOST" 'cd /root/moontvplus && DOCKER_BUILDKIT=1 docker compose build && docker compose up -d --no-build'
