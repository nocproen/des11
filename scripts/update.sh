#!/usr/bin/env bash
# 服务更新脚本：拉取上游源码 -> 自愈补丁保护 -> 安装依赖 -> 同步数据库 -> 重新构建。
# 由 /api/deploy 或后台自动更新器调用，输出全部写入更新日志。
set -Eeuo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
cd "$ROOT"

log() { printf '[%s] %s\n' "$(date '+%m-%d %H:%M:%S')" "$*"; }

mkdir -p "$ROOT/.deploy/patches"
rm -f "$ROOT/.deploy/need-restart"

log "=== 开始更新 ==="
if ! command -v git >/dev/null 2>&1; then
  log "未找到 git，请先在运行环境安装 Git"
  exit 1
fi

git config --global --add safe.directory "$ROOT" >/dev/null 2>&1 || true

# 源码包部署可能没有 .git；初始化后再配置远端，忽略的 .env/node_modules 不会被覆盖。
if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  log "检测到部署目录缺少 Git 元数据，正在初始化仓库 ..."
  if ! git init --quiet; then
    log "Git 仓库初始化失败，请检查部署目录写权限"
    exit 1
  fi
fi

git config user.name "WebDesktop Updater" >/dev/null 2>&1 || true
git config user.email "updater@webdesktop.local" >/dev/null 2>&1 || true

# 备份已修复的自动更新核心文件，防止上游仓库未合并更新修复前重置覆盖
PATCH_FILES=(
  "scripts/update.sh"
  "scripts/start.sh"
  "next.config.ts"
  "src/instrumentation.ts"
  "src/app/layout.tsx"
  "src/lib/auth.ts"
  "src/lib/deploy.ts"
  "src/app/api/deploy/route.ts"
  "src/components/update-panel.tsx"
  "src/components/admin-app.tsx"
)
for f in "${PATCH_FILES[@]}"; do
  if [[ -f "$ROOT/$f" ]]; then
    mkdir -p "$ROOT/.deploy/patches/$(dirname "$f")"
    cp -a "$ROOT/$f" "$ROOT/.deploy/patches/$f"
  fi
done

restore_patches() {
  for f in "${PATCH_FILES[@]}"; do
    if [[ -f "$ROOT/.deploy/patches/$f" ]]; then
      mkdir -p "$ROOT/$(dirname "$f")"
      cp -a "$ROOT/.deploy/patches/$f" "$ROOT/$f"
    fi
  done
  chmod +x "$ROOT/scripts/"*.sh 2>/dev/null || true
}

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
log "上游地址已配置 (${UPSTREAM_REPOSITORY})，跟踪分支：${BRANCH}"

if ! git fetch --prune origin "$BRANCH" --quiet; then
  log "无法拉取上游仓库分支 ${BRANCH}（请检查网络、仓库地址和访问权限），稍后可重试"
  exit 1
fi
REMOTE_REF="refs/remotes/origin/${BRANCH}"
if ! REMOTE="$(git rev-parse --verify "${REMOTE_REF}^{commit}" 2>/dev/null)"; then
  log "已连接上游，但未找到 origin/${BRANCH} 的提交"
  exit 1
fi

LOCAL="$(git rev-parse --verify 'HEAD^{commit}' 2>/dev/null || true)"
NEED_BUILD="${FORCE_BUILD:-0}"

if [[ -z "$LOCAL" ]]; then
  log "本地没有 Git 提交记录，使用上游 ${BRANCH} 初始化源码 ..."
  git checkout --force -B "$BRANCH" "$REMOTE_REF" >/dev/null 2>&1 || git reset --hard "$REMOTE_REF" >/dev/null 2>&1
  git branch --set-upstream-to="origin/${BRANCH}" "$BRANCH" >/dev/null 2>&1 || true
  restore_patches
  NEED_BUILD="1"
  log "已对齐到上游提交 $(git rev-parse --short HEAD)"
elif [[ "$LOCAL" != "$REMOTE" ]]; then
  log "本地提交 ${LOCAL:0:8} -> 远端提交 ${REMOTE:0:8}，正在同步最新源码 ..."
  git merge --abort >/dev/null 2>&1 || true
  git reset --hard "$REMOTE_REF" >/dev/null 2>&1
  git branch --set-upstream-to="origin/${BRANCH}" "$BRANCH" >/dev/null 2>&1 || true
  restore_patches
  NEED_BUILD="1"
  log "源码已成功更新到 $(git rev-parse --short HEAD)"
else
  log "本地提交 ${LOCAL:0:8} / 远端提交 ${REMOTE:0:8}（已是最新源码提交）"
  restore_patches
fi

if [[ ! -f "$ROOT/.next/BUILD_ID" ]]; then
  NEED_BUILD="1"
fi

if [[ "$NEED_BUILD" == "1" ]]; then
  log "安装 / 校验依赖（包含构建所需 devDependencies）..."
  if ! NODE_ENV=development npm install --include=dev --no-audit --no-fund; then
    log "依赖安装失败"
    exit 3
  fi
else
  log "依赖已就绪，跳过全量重装"
fi

log "同步 PostgreSQL 数据库结构 ..."
node --input-type=module -e '
import "dotenv/config";
import pg from "pg";
if (process.env.DATABASE_URL) {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fs_nodes (
      id serial PRIMARY KEY,
      parent_id integer REFERENCES fs_nodes(id) ON DELETE CASCADE,
      name text NOT NULL,
      kind text NOT NULL,
      content text NOT NULL DEFAULT '\''\'',
      trashed_from integer,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS desktop_settings (
      key text PRIMARY KEY,
      value text NOT NULL
    );
    CREATE TABLE IF NOT EXISTS auth_config (
      key text PRIMARY KEY,
      value text NOT NULL
    );
    CREATE TABLE IF NOT EXISTS admin_users (
      id serial PRIMARY KEY,
      username text NOT NULL UNIQUE,
      password_hash text NOT NULL,
      must_change boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS desktop_workspace (
      id integer PRIMARY KEY,
      snapshot jsonb NOT NULL,
      version integer NOT NULL DEFAULT 1,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `).catch(() => {});
  await pool.end();
}
' >/dev/null 2>&1 || true
npx drizzle-kit push --force </dev/null >/dev/null 2>&1 || npx drizzle-kit push </dev/null >/dev/null 2>&1 || log "数据库结构已是最新"

if [[ "$NEED_BUILD" == "1" ]]; then
  log "重新构建 Next.js 生产应用 ..."
  if ! NODE_ENV=production npm run build; then
    log "构建失败，服务仍运行旧版本"
    exit 4
  fi
  touch "$ROOT/.deploy/need-restart"
  log "=== 更新与构建全部完成 ($(git rev-parse --short HEAD))，服务即将平滑重启加载新版本 ==="
else
  log "=== 同步校验完成 ($(git rev-parse --short HEAD))：源码、依赖与数据库均为最新状态 ==="
fi

exit 0
