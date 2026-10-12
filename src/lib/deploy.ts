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
};

const ROOT = process.cwd();
const LOG_DIR = path.join(ROOT, ".deploy");
const LOG_FILE = path.join(LOG_DIR, "update.log");
const LOG_TAIL = 12_000;

type Holder = { status: DeployStatus; timer?: NodeJS.Timeout; child?: ReturnType<typeof spawn> };
const holder = globalThis as unknown as { __wdDeploy?: Holder };

function initial(): DeployStatus {
  return {
    running: false,
    localCommit: "",
    remoteCommit: "",
    behind: 0,
    updateAvailable: false,
    lastCheck: null,
    lastRunAt: null,
    lastResult: null,
    message: "",
    log: "",
    buildId: process.env.NEXT_PUBLIC_WD_BUILD ?? "",
    autoUpdate: process.env.AUTO_UPDATE !== "0",
    restartOnUpdate: process.env.UPDATE_RESTART !== "0",
    intervalMin: Math.max(1, Number(process.env.UPDATE_INTERVAL_MIN || 10) || 10),
    remoteUrl: "",
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

async function appendLog(text: string) {
  try {
    await fsp.mkdir(LOG_DIR, { recursive: true });
    await fsp.appendFile(LOG_FILE, text, "utf8");
  } catch {
    /* 日志写入失败不影响更新 */
  }
}

/** 与上游仓库比对，返回是否有新版本（不会修改任何文件） */
export async function checkRemote(force = true): Promise<DeployStatus> {
  const S = deployState();
  const st = S.status;
  if (st.running) return st;
  if (!force && st.lastCheck && Date.now() - st.lastCheck < 30_000) return st;

  const remote = await run("git", ["remote", "get-url", "origin"], 20_000);
  if (remote.code === 0) st.remoteUrl = remote.out.trim();

  const fetch = await run("git", ["fetch", "origin", "master", "--quiet"], 90_000);
  const local = await run("git", ["rev-parse", "HEAD"], 20_000);
  const head = await run("git", ["rev-parse", "origin/master"], 20_000);
  st.localCommit = local.out.trim();
  st.remoteCommit = head.code === 0 ? head.out.trim() : "";

  if (fetch.code !== 0 || !st.remoteCommit) {
    st.lastCheck = Date.now();
    st.updateAvailable = false;
    st.behind = 0;
    st.message = "无法访问上游仓库，稍后自动重试";
    return st;
  }

  const behind = await run("git", ["rev-list", "--count", "HEAD..origin/master"], 20_000);
  st.behind = Number(behind.out.trim()) || 0;
  st.updateAvailable = st.behind > 0;
  st.lastCheck = Date.now();
  st.message = st.updateAvailable ? `发现 ${st.behind} 个新提交` : "已是最新版本";
  return st;
}

/** 执行更新：拉源码 -> 装依赖 -> 同步数据库 -> 重新构建 ->（可选）重启服务 */
export async function applyUpdate(): Promise<DeployStatus> {
  const S = deployState();
  const st = S.status;
  if (st.running) return st;

  st.running = true;
  st.lastRunAt = Date.now();
  st.lastResult = null;
  st.message = "正在更新…";
  st.log = "";
  await appendLog(`\n===== ${new Date().toISOString()} 开始更新 =====\n`);

  const child = spawn("bash", [path.join(ROOT, "scripts", "update.sh")], {
    cwd: ROOT,
    env: process.env,
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

  child.on("close", (code) => {
    st.running = false;
    if (code === 0) {
      st.lastResult = "ok";
      st.message = "更新完成，服务即将重启";
      void checkRemote(false);
      if (st.restartOnUpdate) {
        // 给响应一点时间发出去，再退出进程让平台重新拉起新版本
        setTimeout(() => process.exit(0), 2500);
      }
    } else {
      st.lastResult = "error";
      st.message = `更新失败（退出码 ${code ?? -1}），服务继续运行旧版本`;
    }
    void appendLog(`===== 结束，退出码 ${code ?? -1} =====\n`);
  });

  return st;
}

/** 后台巡检：源码有变化就自动更新 */
export function startDeployWatcher() {
  const S = deployState();
  if (S.timer) return;
  const tick = async () => {
    try {
      if (S.status.running) return;
      await checkRemote();
      if (S.status.updateAvailable && S.status.autoUpdate) await applyUpdate();
    } catch (e) {
      console.error("[deploy] 自动更新检查失败", e);
    }
  };
  const first = setTimeout(tick, 25_000);
  void first;
  const timer = setInterval(tick, S.status.intervalMin * 60_000);
  timer.unref?.();
  S.timer = timer;
}
