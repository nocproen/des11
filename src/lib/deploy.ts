import { spawn } from "child_process";
import fsp from "fs/promises";
import path from "path";

// 服务更新：跟踪 GitHub 上游源码，检测到新提交时拉取源码、安装依赖、同步数据库并重新构建。
// 所有状态挂在 globalThis 上，避免 Next 把模块打包成多份实例。

export type DeployStatus = {
  running: boolean;
  localCommit: string;
  remoteCommit: string;
  behind: number;
  updateAvailable: boolean;
  lastCheck: number | null;
  lastRunAt: number | null;
  lastResult: "ok" | "error" | null;
  message: string;
  log: string;
  buildId: string;
  autoUpdate: boolean;
  restartOnUpdate: boolean;
  intervalMin: number;
  remoteUrl: string;
  branch: string;
};

const ROOT = process.cwd();
const LOG_DIR = path.join(ROOT, ".deploy");
const LOG_FILE = path.join(LOG_DIR, "update.log");
const NEED_RESTART_FILE = path.join(LOG_DIR, "need-restart");
const LOG_TAIL = 12_000;
const FALLBACK_UPSTREAM = "https://github.com/nocproen/des11.git";
const UPSTREAM_REPOSITORY = process.env.UPSTREAM_REPOSITORY?.trim() || FALLBACK_UPSTREAM;

type Holder = { status: DeployStatus; timer?: NodeJS.Timeout; child?: ReturnType<typeof spawn> };
const holder = globalThis as unknown as { __wdDeploy?: Holder };

function initial(): DeployStatus {
  return {
    running: false,
    localCommit: process.env.NEXT_PUBLIC_WD_COMMIT ?? "",
    remoteCommit: "",
    behind: 0,
    updateAvailable: false,
    lastCheck: null,
    lastRunAt: null,
    lastResult: "ok",
    message: "就绪",
    log: "",
    buildId: process.env.NEXT_PUBLIC_WD_BUILD ?? "",
    autoUpdate: process.env.AUTO_UPDATE !== "0",
    restartOnUpdate: process.env.UPDATE_RESTART !== "0",
    intervalMin: Math.max(1, Number(process.env.UPDATE_INTERVAL_MIN || 5) || 5),
    remoteUrl: UPSTREAM_REPOSITORY,
    branch: process.env.UPSTREAM_BRANCH?.trim() || "master",
  };
}

export function deployState(): Holder {
  return (holder.__wdDeploy ??= { status: initial() });
}

export async function readLogTail(): Promise<string> {
  try {
    return (await fsp.readFile(LOG_FILE, "utf8")).slice(-LOG_TAIL);
  } catch {
    return "";
  }
}

function run(cmd: string, args: string[], timeout = 180_000) {
  return new Promise<{ code: number; out: string }>((resolve) => {
    const p = spawn(cmd, args, { cwd: ROOT, env: process.env });
    let out = "";
    const kill = setTimeout(() => p.kill("SIGKILL"), timeout);
    p.stdout.on("data", (d) => (out += String(d)));
    p.stderr.on("data", (d) => (out += String(d)));
    p.on("error", (e) => {
      clearTimeout(kill);
      resolve({ code: -1, out: String(e) });
    });
    p.on("close", (code) => {
      clearTimeout(kill);
      resolve({ code: code ?? -1, out });
    });
  });
}

function safeRemoteUrl(value: string) {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    return value;
  }
}

function validBranch(branch: string) {
  return /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) && !branch.includes("..");
}

async function resolveUpstream(): Promise<{ remoteUrl: string; branch: string; error: string | null }> {
  await run("git", ["config", "--global", "--add", "safe.directory", ROOT], 5_000);

  const repository = await run("git", ["rev-parse", "--is-inside-work-tree"], 10_000);
  if (repository.code !== 0) {
    const init = await run("git", ["init", "--quiet"], 20_000);
    if (init.code !== 0) {
      return { remoteUrl: "", branch: "", error: "无法在部署目录初始化 Git 元数据" };
    }
  }

  await run("git", ["config", "user.name", "WebDesktop Updater"], 5_000);
  await run("git", ["config", "user.email", "updater@webdesktop.local"], 5_000);

  let remote = await run("git", ["remote", "get-url", "origin"], 10_000);
  if (remote.code !== 0) {
    const add = await run("git", ["remote", "add", "origin", UPSTREAM_REPOSITORY], 10_000);
    if (add.code !== 0) {
      return { remoteUrl: "", branch: "", error: "无法配置 origin 上游地址" };
    }
    remote = await run("git", ["remote", "get-url", "origin"], 10_000);
  } else if (process.env.UPSTREAM_REPOSITORY?.trim() && remote.out.trim() !== UPSTREAM_REPOSITORY) {
    const set = await run("git", ["remote", "set-url", "origin", UPSTREAM_REPOSITORY], 10_000);
    if (set.code !== 0) {
      return { remoteUrl: "", branch: "", error: "无法更新 origin 上游地址" };
    }
    remote = await run("git", ["remote", "get-url", "origin"], 10_000);
  }

  const remoteUrl = safeRemoteUrl(remote.out.trim() || UPSTREAM_REPOSITORY);
  let branch = process.env.UPSTREAM_BRANCH?.trim() || "";
  if (branch && !validBranch(branch)) {
    return { remoteUrl, branch: "", error: "UPSTREAM_BRANCH 配置无效" };
  }

  if (!branch) {
    const symbolicHead = await run("git", ["ls-remote", "--symref", "origin", "HEAD"], 30_000);
    const defaultRefLine = symbolicHead.out.split("\n").find((line) => line.startsWith("ref: refs/heads/") && line.endsWith(" HEAD"));
    const advertisedBranch = defaultRefLine?.slice("ref: refs/heads/".length, -" HEAD".length).trim() || "";
    if (advertisedBranch && validBranch(advertisedBranch)) branch = advertisedBranch;
  }

  if (!branch) {
    const listing = await run("git", ["ls-remote", "--heads", "origin"], 45_000);
    const branches = listing.out
      .split("\n")
      .map((line) => {
        const ref = line.trim().split("\t")[1] || "";
        return ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : "";
      })
      .filter(validBranch);
    branch = branches.includes("master") ? "master" : branches.includes("main") ? "main" : branches[0] || "master";
  }

  return { remoteUrl, branch, error: null };
}

async function appendLog(text: string) {
  try {
    await fsp.mkdir(LOG_DIR, { recursive: true });
    await fsp.appendFile(LOG_FILE, text, "utf8");
  } catch {
    /* 日志写入失败不影响更新 */
  }
}

/** 与上游仓库比对；源码包无 Git 历史时仍可发现远端并允许手动或自动对齐。 */
export async function checkRemote(force = true): Promise<DeployStatus> {
  const S = deployState();
  const st = S.status;
  if (st.running) return st;
  if (!force && st.lastCheck && Date.now() - st.lastCheck < 25_000) return st;

  const fail = (message: string) => {
    st.lastCheck = Date.now();
    st.updateAvailable = false;
    st.behind = 0;
    st.lastResult = "error";
    st.message = message;
    return st;
  };

  const upstream = await resolveUpstream();
  if (upstream.error) return fail(upstream.error);
  st.remoteUrl = upstream.remoteUrl;
  st.branch = upstream.branch;

  const remoteRef = `refs/remotes/origin/${upstream.branch}`;
  const fetch = await run("git", ["fetch", "--prune", "origin", upstream.branch, "--quiet"], 60_000);
  const local = await run("git", ["rev-parse", "--verify", "HEAD^{commit}"], 15_000);
  const head = await run("git", ["rev-parse", "--verify", `${remoteRef}^{commit}`], 15_000);
  const packagedCommit =
    process.env.NEXT_PUBLIC_WD_COMMIT || process.env.VERCEL_GIT_COMMIT_SHA || process.env.GITHUB_SHA || "";
  st.localCommit = local.code === 0 ? local.out.trim() : packagedCommit;
  st.remoteCommit = head.code === 0 ? head.out.trim() : "";

  if (fetch.code !== 0 || !st.remoteCommit) {
    const hint = fetch.out.toLowerCase().includes("not a git repository")
      ? "部署目录无法初始化 Git 元数据"
      : `请检查网络、origin 地址及仓库权限（分支 ${upstream.branch}）`;
    return fail(`无法拉取上游仓库：${hint}`);
  }

  // 若本地尚无 HEAD 提交记录，自动将 Git 基线指向远端提交
  if (local.code !== 0 && st.remoteCommit) {
    await run("git", ["checkout", "--force", "-B", upstream.branch, remoteRef], 20_000);
    await run("git", ["branch", `--set-upstream-to=origin/${upstream.branch}`, upstream.branch], 10_000);
    const fixedLocal = await run("git", ["rev-parse", "--verify", "HEAD^{commit}"], 10_000);
    if (fixedLocal.code === 0) {
      st.localCommit = fixedLocal.out.trim();
    }
  }

  const localRevision = st.localCommit.trim();
  const isCommitHash = /^[a-f0-9]{7,64}$/i.test(localRevision);
  if (localRevision && localRevision === st.remoteCommit) {
    st.behind = 0;
    st.updateAvailable = false;
    st.lastCheck = Date.now();
    if (st.lastResult !== "error") st.lastResult = "ok";
    st.message = `已是最新版本（${upstream.branch} @ ${localRevision.slice(0, 8)}）`;
    return st;
  }

  const knownCommit = isCommitHash
    ? await run("git", ["cat-file", "-e", `${localRevision}^{commit}`], 10_000)
    : { code: 1, out: "" };
  if (knownCommit.code === 0) {
    const behind = await run("git", ["rev-list", "--count", `${localRevision}..${remoteRef}`], 20_000);
    if (behind.code === 0) {
      st.behind = Math.max(0, Number(behind.out.trim()) || 0);
      st.updateAvailable = st.behind > 0;
      st.lastCheck = Date.now();
      st.message = st.updateAvailable
        ? `发现 ${st.behind} 个上游新提交（${st.remoteCommit.slice(0, 8)}）`
        : `已是最新版本（${upstream.branch} @ ${localRevision.slice(0, 8)}）`;
      return st;
    }
  }

  st.behind = 1;
  st.updateAvailable = true;
  st.lastCheck = Date.now();
  st.message = "检测到上游版本差异，可一键同步至最新源码";
  return st;
}

function triggerGracefulRestart() {
  setTimeout(() => {
    try {
      const child = spawn(
        "bash",
        ["-c", `sleep 0.5 && bash "${path.join(ROOT, "scripts", "start.sh")}" >> /tmp/wd-restart.log 2>&1`],
        {
          cwd: ROOT,
          env: process.env,
          detached: true,
          stdio: "ignore",
        },
      );
      child.unref();
    } catch (e) {
      console.error("[deploy] 启动重启脚本失败", e);
    }
  }, 1500);
}

/** 执行更新：拉源码 -> 装依赖 -> 同步数据库 -> 重新构建 ->（可选）平滑重启服务 */
export async function applyUpdate(options?: { forceBuild?: boolean }): Promise<DeployStatus> {
  const S = deployState();
  const st = S.status;
  if (st.running) return st;

  const forceBuild = options?.forceBuild === true;
  st.running = true;
  st.lastRunAt = Date.now();
  st.lastResult = null;
  st.message = forceBuild ? "正在强制同步并重新构建…" : "正在同步上游源码与更新…";
  st.log = "";
  const header = `\n===== ${new Date().toISOString()} 开始更新${forceBuild ? "（强制重建）" : ""} =====\n`;
  st.log = header;
  await appendLog(header);

  const child = spawn("bash", [path.join(ROOT, "scripts", "update.sh")], {
    cwd: ROOT,
    env: {
      ...process.env,
      FORCE_BUILD: forceBuild ? "1" : "0",
    },
  });
  S.child = child;

  const absorb = (d: Buffer) => {
    const text = String(d);
    st.log = (st.log + text).slice(-LOG_TAIL);
    void appendLog(text);
  };
  child.stdout.on("data", absorb);
  child.stderr.on("data", absorb);

  child.on("error", (e) => {
    st.running = false;
    st.lastResult = "error";
    st.message = `更新进程启动失败：${String(e)}`;
  });

  child.on("close", async (code) => {
    st.running = false;
    let needRestart = false;
    try {
      await fsp.access(NEED_RESTART_FILE);
      needRestart = true;
      await fsp.rm(NEED_RESTART_FILE, { force: true });
    } catch {
      needRestart = false;
    }

    if (code === 0) {
      await checkRemote(true);
      st.lastResult = "ok";
      if (needRestart) {
        st.message = st.restartOnUpdate
          ? `更新构建完成（${st.localCommit.slice(0, 8)}），正在平滑重启服务加载新版本…`
          : `更新构建完成（${st.localCommit.slice(0, 8)}）；请重启服务以加载新版本`;
        if (st.restartOnUpdate) {
          triggerGracefulRestart();
        }
      } else {
        st.message = `同步校验成功：当前已是最新版本（${st.branch} @ ${st.localCommit.slice(0, 8)}）`;
      }
    } else {
      st.lastResult = "error";
      st.message = `更新失败（退出码 ${code ?? -1}），请查看下方日志详情`;
    }
    void appendLog(`===== 结束，退出码 ${code ?? -1} =====\n`);
  });

  return st;
}

export function updateDeployConfig(patch: {
  autoUpdate?: boolean;
  restartOnUpdate?: boolean;
  intervalMin?: number;
}): DeployStatus {
  const S = deployState();
  const st = S.status;
  if (typeof patch.autoUpdate === "boolean") st.autoUpdate = patch.autoUpdate;
  if (typeof patch.restartOnUpdate === "boolean") st.restartOnUpdate = patch.restartOnUpdate;
  if (typeof patch.intervalMin === "number" && Number.isFinite(patch.intervalMin)) {
    st.intervalMin = Math.max(1, Math.min(1440, Math.round(patch.intervalMin)));
  }
  if (S.timer) {
    clearInterval(S.timer);
    S.timer = undefined;
  }
  startDeployWatcher();
  return st;
}

/** 后台巡检：源码有变化就自动更新 */
export function startDeployWatcher() {
  const S = deployState();
  if (S.timer) return;
  const tick = async () => {
    try {
      if (S.status.running) return;
      await checkRemote(true);
      if (S.status.updateAvailable && S.status.autoUpdate) {
        await applyUpdate();
      }
    } catch (e) {
      console.error("[deploy] 自动更新检查失败", e);
    }
  };
  const first = setTimeout(tick, 5_000);
  first.unref?.();
  const timer = setInterval(tick, S.status.intervalMin * 60_000);
  timer.unref?.();
  S.timer = timer;
}
