#!/usr/bin/env bash
# 服务更新脚本：拉取 GitHub 源码 -> 安装依赖 -> 同步数据库结构 -> 重新构建
# 由 /api/deploy 或后台自动更新器调用，输出全部写入更新日志。
set -uo pipefail
cd "$(dirname "$0")/.."

log() { printf '[%s] %s\n' "$(date '+%m-%d %H:%M:%S')" "$*"; }

log "=== 开始更新 ==="

if ! git fetch origin master --quiet; then
  log "无法访问上游仓库（网络或仓库地址不可达）"
  exit 1
fi

LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/master)
log "本地提交 ${LOCAL:0:8} / 远端提交 ${REMOTE:0:8}"

if [ "$LOCAL" = "$REMOTE" ]; then
  log "源码无变化，无需更新"
  exit 0
fi

BEHIND=$(git rev-list --count "HEAD..origin/master" 2>/dev/null || echo 0)
log "上游有 ${BEHIND} 个新提交，开始合并 ..."

if ! git merge --no-edit -X theirs origin/master >/dev/null 2>&1; then
  log "合并出现冲突，已回滚本次合并，请手动处理"
  git merge --abort >/dev/null 2>&1
  exit 2
fi
log "源码已更新到 $(git rev-parse --short HEAD)"

log "安装 / 校验依赖 ..."
if ! npm install --no-audit --no-fund; then
  log "依赖安装失败"
  exit 3
fi

log "同步数据库结构 ..."
npx drizzle-kit push --force </dev/null >/dev/null 2>&1 || npx drizzle-kit push </dev/null >/dev/null 2>&1 || log "数据库结构无需变更"

log "重新构建应用 ..."
if ! npm run build; then
  log "构建失败，服务仍运行旧版本"
  exit 4
fi

log "=== 更新完成，服务即将重启以加载新版本 ==="
exit 0
