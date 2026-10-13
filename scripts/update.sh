#!/usr/bin/env bash
# 服务更新脚本：拉取上游源码 -> 安装依赖 -> 同步数据库 -> 重新构建。
# 由 /api/deploy 或后台自动更新器调用，输出全部写入更新日志。
set -Eeuo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
cd "$ROOT"

log() { printf '[%s] %s\n' "$(date '+%m-%d %H:%M:%S')" "$*"; }

log "=== 开始更新 ==="
if ! command -v git >/dev/null 2>&1; then
  log "未找到 git，请先在运行环境安装 Git"
  exit 1
fi

# 源码包部署可能没有 .git；初始化后再配置远端，忽略的 .env/node_modules 不会被覆盖。
if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  log "检测到部署目录缺少 Git 元数据，正在初始化仓库 ..."
  if ! git init --quiet; then
    log "Git 仓库初始化失败，请检查部署目录写权限"
    exit 1
  fi
fi

UPSTREAM_REPOSITORY="${UPSTREAM_REPOSITORY:-}"
if [[ -z "$UPSTREAM_REPOSITORY" ]]; then
  UPSTREAM_REPOSITORY="$(git remote get-url origin 2>/dev/null || true)"
fi
UPSTREAM_REPOSITORY="${UPSTREAM_REPOSITORY:-https://github.com/nocproen/des11.git}"
if ! git remote get-url origin >/dev/null 2>&1; then
  if ! git remote add origin "$UPSTREAM_REPOSITORY"; then
    log "无法配置上游 origin，请检查仓库地址"
    exit 1
  fi
elif [[ -n "${UPSTREAM_REPOSITORY:-}" ]] && [[ "$(git remote get-url origin)" != "$UPSTREAM_REPOSITORY" ]]; then
  if ! git remote set-url origin "$UPSTREAM_REPOSITORY"; then
    log "无法更新上游 origin 地址"
    exit 1
  fi
fi

BRANCH="${UPSTREAM_BRANCH:-}"
if [[ -z "$BRANCH" ]]; then
  DEFAULT_REF="$(git ls-remote --symref origin HEAD 2>/dev/null | awk '$1 == "ref:" && $3 == "HEAD" { sub("^refs/heads/", "", $2); print $2; exit }' || true)"
  BRANCH="$DEFAULT_REF"
fi
if [[ -z "$BRANCH" ]]; then
  BRANCHES="$(git ls-remote --heads origin 2>/dev/null | awk '{ sub("^refs/heads/", "", $2); print $2 }' || true)"
  if grep -Fxq master <<<"$BRANCHES"; then
    BRANCH="master"
  elif grep -Fxq main <<<"$BRANCHES"; then
    BRANCH="main"
  else
    BRANCH="$(head -n 1 <<<"$BRANCHES" || true)"
  fi
fi
if [[ -z "$BRANCH" ]] || ! git check-ref-format --branch "$BRANCH" >/dev/null 2>&1 || [[ "$BRANCH" == *".."* ]]; then
  log "无法识别有效的上游分支，请检查 UPSTREAM_BRANCH 与仓库默认分支"
  exit 1
fi
log "上游地址已配置，跟踪分支：${BRANCH}"

if ! git fetch --prune origin "$BRANCH" --quiet; then
  log "无法拉取上游仓库分支 ${BRANCH}（请检查网络、仓库地址和访问权限），稍后可重试"
  exit 1
fi
REMOTE_REF="refs/remotes/origin/${BRANCH}"
if ! REMOTE="$(git rev-parse --verify "${REMOTE_REF}^{commit}" 2>/dev/null)"; then
  log "已连接上游，但未找到 origin/${BRANCH} 的提交"
  exit 1
fi

# 源码包没有 HEAD 时以远端基线建立跟踪分支；.env 与运行数据均由 .gitignore 保护。
if ! LOCAL="$(git rev-parse --verify 'HEAD^{commit}' 2>/dev/null)"; then
  log "本地没有 Git 提交记录，使用上游 ${BRANCH} 初始化源码 ..."
  if ! git checkout --force -B "$BRANCH" "$REMOTE_REF" >/dev/null 2>&1; then
    if ! git reset --hard "$REMOTE_REF" >/dev/null 2>&1; then
      log "无法将部署目录对齐到上游分支"
      exit 2
    fi
  fi
  git branch --set-upstream-to="origin/${BRANCH}" "$BRANCH" >/dev/null 2>&1 || true
  log "已初始化到上游提交 $(git rev-parse --short HEAD)"
else
  log "本地提交 ${LOCAL:0:8} / 远端提交 ${REMOTE:0:8}"
  if [[ "$LOCAL" == "$REMOTE" ]]; then
    log "源码无变化，无需更新"
    exit 0
  fi

  BEHIND="$(git rev-list --count "HEAD..${REMOTE_REF}" 2>/dev/null || echo 0)"
  log "上游有 ${BEHIND} 个新提交，开始合并 ..."
  if [[ "$BEHIND" -eq 0 ]]; then
    log "本地没有落后于上游的新提交，无需更新"
    exit 0
  fi

  if ! git merge --no-edit -X theirs "$REMOTE_REF" >/dev/null 2>&1; then
    git merge --abort >/dev/null 2>&1 || true
    LOCAL_ONLY="$(git rev-list --count "${REMOTE_REF}..HEAD" 2>/dev/null || echo 0)"
    BASE="$(git merge-base HEAD "$REMOTE_REF" 2>/dev/null || true)"
    if [[ -z "$BASE" ]] || [[ "$LOCAL_ONLY" -eq 0 ]]; then
      log "本地与上游历史不一致或本地无独有提交，直接对齐上游 ..."
      if git reset --hard "$REMOTE_REF" >/dev/null 2>&1; then
        log "已对齐上游 $(git rev-parse --short HEAD)"
      else
        log "对齐上游失败，请手动处理"
        exit 2
      fi
    else
      log "合并冲突且本地存在独有提交，已回滚本次合并，请手动处理"
      exit 2
    fi
  fi
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
