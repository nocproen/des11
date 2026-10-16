import { execFile, spawn, type ChildProcess } from "child_process";
import fsp from "fs/promises";
import type http from "http";
import net from "net";
import path from "path";
import type { Duplex } from "stream";
import type { RawData, WebSocket, WebSocketServer } from "ws";
import { desktopAuthState } from "@/lib/auth";
import { cleanEnv, ensureBin } from "@/lib/proc-env";
import { DESKTOP, HOME, ensureHome } from "@/lib/sys";

// 运行 Linux 图形程序（如 Clash Verge）：
//  每个应用窗口 = 服务器上一个独立的虚拟显示器(Xvnc) + 极简窗口管理器(openbox) + 应用本身。
//  画面通过 VNC 协议经 WebSocket 转发到网页，网页端用 noVNC 渲染，并把鼠标键盘转发回去。

export const GUI_PATH = "/api/gui/ws";

export type GuiState = "preparing" | "starting" | "running" | "exited" | "failed";

type Gui = {
  id: string;
  name: string;
  exec: string;
  cwd: string;
  w: number;
  h: number;
  state: GuiState;
  note: string;
  log: string;
  exitCode: number | null;
  display: number;
  port: number;
  xvnc: ChildProcess | null;
  app: ChildProcess | null;
  clients: number;
  lastSeen: number;
  endedAt: number;
  stopped: boolean;
  preset: string;
  // —— 链路质量（由 WebSocket 心跳实测，供网页端自适应画质）——
  rtt: number; // 平滑后的往返延迟 ms，0 = 还没测到
  stalls: number; // 发生过多少次发送积压（带宽不够的直接信号）
};

export type ServerClip = {
  kind: "files" | "image" | "text";
  paths: string[];
  cut: boolean;
  pngPath?: string;
  text?: string;
  ts: number;
};

type Store = {
  cleaned?: boolean;
  browserPkgs?: Promise<void>;
  lastBrowserStop: number;
  sessions: Map<string, Gui>;
  ended?: Map<string, string>; // 最近结束的会话 -> 结束原因（让网页能告诉用户真正的原因）
  stack?: Promise<void>;
  stackNote: string;
  pick: Promise<unknown>;
  timer?: NodeJS.Timeout;
  apps?: { t: number; v: { apps: DesktopEntry[]; desktop: DesktopEntry[] } };
  clip?: ServerClip | null;
  clipProcs?: Map<number, ChildProcess>;
};
const holder = globalThis as unknown as { __wdGui?: Store };
const G: Store = (holder.__wdGui ??= { sessions: new Map(), stackNote: "", pick: Promise.resolve(), lastBrowserStop: -1e9 });
G.lastBrowserStop ??= -1e9;
G.clipProcs ??= new Map();

const MAX_SESSIONS = 4;
// 没有任何网页连着时，应用多保留多久（网页端会在这段时间内自动重连）。
// 所有"空闲"计时都用单调时钟：本机会被平台整机冻结（可达数小时），恢复时墙钟（Date.now）会一次跳过去，
// 但单调时钟不走，冻结的时间不该算作"没人连"。
const IDLE_MS = 2 * 60 * 60_000;
const mono = () => performance.now();
const stamp = () => new Date().toISOString();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clamp = (v: unknown, lo: number, hi: number, d: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : d;
};

/* ---------------- 图形环境：首次使用时自动安装 ---------------- */

const NEED_BINS = ["Xvnc", "openbox", "dbus-run-session", "xclip", "xdotool"];
const PKGS = [
  "tigervnc-standalone-server",
  "openbox",
  "dbus-x11",
  "x11-utils",
  "x11-xserver-utils",
  "xfonts-base",
  "xterm",
  "fonts-dejavu-core",
  "xdg-utils",
  "xclip",
  "xsel",
  "xdotool",
  "python3-gi",
  "gir1.2-gtk-3.0",
  "python3-pil",
  "pcmanfm",
];

async function hasBin(name: string) {
  const dirs = (process.env.PATH ?? "").split(":").concat(["/usr/bin", "/usr/local/bin", "/bin"]);
  for (const d of dirs) {
    try {
      await fsp.access(path.join(d, name), 1);
      return true;
    } catch {
      /* 继续找 */
    }
  }
  return false;
}

async function hasStack() {
  for (const b of NEED_BINS) if (!(await hasBin(b))) return false;
  return true;
}

function run(cmd: string, args: string[], timeout: number) {
  return new Promise<{ code: number; out: string }>((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1) : 0;
      resolve({ code, out: String(stdout) + String(stderr) });
    });
  });
}

function ensureStack() {
  G.stack ??= (async () => {
    if (await hasStack()) return;
    const lock = ["-o", "DPkg::Lock::Timeout=180"];
    G.stackNote = "正在更新软件源…";
    await run("sudo", ["-n", "apt-get", "update", "-q", ...lock], 240_000);
    G.stackNote = "正在安装图形环境（首次使用，约 1–3 分钟）…";
    const r = await run(
      "sudo",
      ["-n", "env", "DEBIAN_FRONTEND=noninteractive", "apt-get", "install", "-y", "-q", "--no-install-recommends", ...lock, ...PKGS],
      900_000,
    );
    if (!(await hasStack())) throw new Error(`图形环境安装失败：${r.out.slice(-300).trim()}`);
  })()
    .then(() => {
      G.stackNote = "";
    })
    .catch((e) => {
      G.stack = undefined;
      G.stackNote = "";
      throw e;
    });
  return G.stack;
}

/* ---------------- 内置「浏览器」：真实 Chromium ---------------- */

const BROWSER_PKGS = ["chromium", "chromium-l10n", "fonts-noto-cjk", "fonts-noto-color-emoji"];

async function pkgInstalled(name: string) {
  const r = await run("dpkg", ["-s", name], 5000);
  return r.code === 0 && /Status: install ok installed/.test(r.out);
}

function ensureBrowserPkgs() {
  G.browserPkgs ??= (async () => {
    const missing: string[] = [];
    for (const p of BROWSER_PKGS) if (!(await pkgInstalled(p))) missing.push(p);
    if (!missing.length) return;
    const lock = ["-o", "DPkg::Lock::Timeout=180"];
    G.stackNote = "正在安装浏览器（首次使用，约 1–3 分钟）…";
    await run("sudo", ["-n", "apt-get", "update", "-q", ...lock], 240_000);
    const r = await run(
      "sudo",
      ["-n", "env", "DEBIAN_FRONTEND=noninteractive", "apt-get", "install", "-y", "-q", "--no-install-recommends", ...lock, ...missing],
      900_000,
    );
    if (!(await hasBin("chromium"))) throw new Error(`浏览器安装失败：${r.out.slice(-300).trim()}`);
  })()
    .then(() => {
      G.stackNote = "";
    })
    .catch((e) => {
      G.browserPkgs = undefined;
      G.stackNote = "";
      throw e;
    });
  return G.browserPkgs;
}

const shq = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;
const BROWSER_FLAGS = [
  "--no-sandbox", // 容器里没有用户命名空间；同时配合 --test-type 隐藏「不受支持的命令行标记」提示条
  "--test-type",
  "--no-first-run",
  "--no-default-browser-check",
  "--password-store=basic",
  "--disable-gpu",
  "--disable-dev-shm-usage",
  "--disable-smooth-scrolling", // 远程画面里滚动一步到位，响应更快
  "--disable-features=Translate,MediaRouter",
  "--disable-component-update",
  "--hide-crash-restore-bubble",
  "--restore-last-session",
  "--force-device-scale-factor=1",
  "--lang=zh-CN",
].join(" ");

function browserCommand(url?: string) {
  const u = url && /^https?:\/\//i.test(url) && url.length <= 4000 ? ` ${shq(url)}` : "";
  return `chromium ${BROWSER_FLAGS} --user-data-dir="$HOME/.webdesktop/chromium-profile"${u}`;
}

const BROWSER_ENV = { GOOGLE_API_KEY: "no", GOOGLE_DEFAULT_CLIENT_ID: "no", GOOGLE_DEFAULT_CLIENT_SECRET: "no" };

/* ---------------- .desktop 启动文件 / 图标 ---------------- */

export type DesktopEntry = {
  file: string;
  name: string;
  exec: string;
  icon: string;
  comment: string;
  cwd: string;
  terminal: boolean;
  hidden: boolean;
  restricted: boolean;
};

export function parseDesktop(file: string, text: string): DesktopEntry | null {
  const kv: Record<string, string> = {};
  let inEntry = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("[")) {
      inEntry = line === "[Desktop Entry]";
      continue;
    }
    if (!inEntry) continue;
    const i = line.indexOf("=");
    if (i > 0) kv[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  if ((kv.Type ?? "Application") !== "Application" || !kv.Exec) return null;
  const exec = kv.Exec.replace(/%%/g, "\u0000")
    .replace(/%[fFuUdDnNickvm]/g, "")
    .replace(/\u0000/g, "%")
    .replace(/\s+/g, " ")
    .trim();
  if (!exec) return null;
  return {
    file,
    name: kv["Name[zh_CN]"] || kv["Name[zh]"] || kv["Name[zh_Hans]"] || kv.Name || path.basename(file, ".desktop"),
    exec,
    icon: kv.Icon ?? "",
    comment: kv["Comment[zh_CN]"] || kv.Comment || "",
    cwd: kv.Path ?? "",
    terminal: kv.Terminal === "true",
    hidden: kv.NoDisplay === "true" || kv.Hidden === "true",
    restricted: !!kv.OnlyShowIn,
  };
}

const APP_DIRS = ["/usr/share/applications", "/usr/local/share/applications", path.join(HOME, ".local/share/applications")];

async function scanDir(dir: string, filter: boolean) {
  const out: DesktopEntry[] = [];
  let names: string[] = [];
  try {
    names = await fsp.readdir(dir);
  } catch {
    return out;
  }
  for (const n of names) {
    if (!n.endsWith(".desktop")) continue;
    const f = path.join(dir, n);
    try {
      const st = await fsp.stat(f);
      if (!st.isFile() || st.size > 100_000) continue;
      const e = parseDesktop(f, await fsp.readFile(f, "utf8"));
      if (!e) continue;
      if (filter && (e.hidden || e.terminal || e.restricted)) continue;
      out.push(e);
    } catch {
      /* 跳过无法读取的文件 */
    }
  }
  return out;
}

/** 已安装的图形应用，以及桌面文件夹里的启动文件 */
export async function listApps() {
  if (G.apps && Date.now() - G.apps.t < 4000) return G.apps.v;
  const byFile = new Map<string, DesktopEntry>();
  for (const d of APP_DIRS) for (const e of await scanDir(d, true)) {
      if (path.basename(e.file) === "chromium.desktop") continue;
      byFile.set(path.basename(e.file), e);
    }
  const apps = [...byFile.values()].sort((a, b) => a.name.localeCompare(b.name, "zh"));
  const desktop = await scanDir(DESKTOP, false);
  G.apps = { t: Date.now(), v: { apps, desktop } };
  return G.apps.v;
}

const iconCache = new Map<string, string | null>();
const IMG_RE = /\.(png|svg|jpe?g|webp|ico)$/i;
const SIZES = ["512x512", "256x256@2", "256x256", "128x128@2", "128x128", "96x96", "64x64", "48x48", "scalable", "32x32"];

async function fileExists(p: string) {
  try {
    return (await fsp.stat(p)).isFile();
  } catch {
    return false;
  }
}

async function searchTheme(name: string) {
  for (const ext of ["png", "svg"]) {
    const p = `/usr/share/pixmaps/${name}.${ext}`;
    if (await fileExists(p)) return p;
  }
  for (const root of ["/usr/share/icons", path.join(HOME, ".local/share/icons")]) {
    let themes: string[] = [];
    try {
      themes = await fsp.readdir(root);
    } catch {
      continue;
    }
    themes.sort((a, b) => (a === "hicolor" ? -1 : b === "hicolor" ? 1 : 0));
    for (const t of themes) {
      for (const size of SIZES) {
        for (const ext of ["png", "svg"]) {
          for (const p of [`${root}/${t}/${size}/apps/${name}.${ext}`, `${root}/${t}/apps/${size}/${name}.${ext}`]) {
            if (await fileExists(p)) return p;
          }
        }
      }
    }
  }
  return null;
}

export async function findIcon(name: string): Promise<string | null> {
  if (!name || name.length > 300) return null;
  if (iconCache.has(name)) return iconCache.get(name)!;
  let found: string | null = null;
  if (path.isAbsolute(name)) {
    if (IMG_RE.test(name) && !name.includes("..") && (await fileExists(name))) found = name;
  } else if (/^[\w.+-]+$/.test(name)) {
    found = await searchTheme(name);
  }
  if (iconCache.size > 500) iconCache.clear();
  iconCache.set(name, found);
  return found;
}

/** 把一个应用的启动文件复制到桌面，生成桌面图标 */
export async function createShortcut(file: string) {
  if (!path.isAbsolute(file) || !file.endsWith(".desktop") || file.includes("..")) throw new Error("文件路径无效");
  const text = await fsp.readFile(file, "utf8");
  if (text.length > 100_000 || !parseDesktop(file, text)) throw new Error("不是有效的应用启动文件");
  await ensureHome();
  const dest = path.join(DESKTOP, path.basename(file));
  await fsp.writeFile(dest, text, { mode: 0o755 });
  await fsp.chmod(dest, 0o755);
  G.apps = undefined;
  return dest;
}

/* ---------------- 会话 ---------------- */

const RC_XML = `<?xml version="1.0" encoding="UTF-8"?>
<openbox_config xmlns="http://openbox.org/3.4/rc">
  <applications>
    <application type="normal"><decor>no</decor><maximized>yes</maximized></application>
  </applications>
</openbox_config>
`;

async function portOpen(port: number) {
  return new Promise<boolean>((resolve) => {
    const s = net.connect({ host: "localhost", port });
    const done = (v: boolean) => {
      s.destroy();
      resolve(v);
    };
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
    s.setTimeout(500, () => done(false));
  });
}

function pickDisplay(g: Gui) {
  const p = G.pick.then(async () => {
    const used = new Set([...G.sessions.values()].map((x) => x.display));
    for (let n = 20; n < 140; n++) {
      if (used.has(n) || (await portOpen(5900 + n))) continue;
      await fsp.rm(`/tmp/.X${n}-lock`, { force: true }); // 清理上次异常退出遗留的锁
      await fsp.rm(`/tmp/.X11-unix/X${n}`, { force: true });
      g.display = n;
      g.port = 5900 + n;
      return n;
    }
    throw new Error("没有可用的显示编号");
  });
  G.pick = p.catch(() => {});
  return p;
}

function killGroup(proc: ChildProcess | null) {
  const pid = proc?.pid;
  if (!pid) return;
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    /* 已退出 */
  }
  setTimeout(() => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      /* 已退出 */
    }
  }, 1500).unref?.();
}

function append(g: Gui, chunk: Buffer | string) {
  g.log = (g.log + chunk.toString()).slice(-16_000);
}

function finish(g: Gui, state: "exited" | "failed", note = "") {
  if (g.state === "exited" || g.state === "failed") return;
  g.state = state;
  if (note) g.note = note;
  g.endedAt = mono();
  killGroup(g.app);
  setTimeout(() => killGroup(g.xvnc), g.preset ? 1500 : 0);
  setTimeout(() => {
    void fsp.rm(`/tmp/.X${g.display}-lock`, { force: true });
    void fsp.rm(`/tmp/.X11-unix/X${g.display}`, { force: true });
  }, 2000).unref?.();
}

const IGNORE = new Set([
  "openbox",
  "dbus-daemon",
  "dbus-launch",
  "dbus-run-sessio",
  "at-spi-bus-laun",
  "at-spi2-registr",
  "gvfsd",
  "dconf-service",
  "ps",
  "sleep",
]);

async function groupBusy(pgid: number) {
  const r = await run("ps", ["-eo", "pgid=,comm="], 5000);
  for (const line of r.out.split("\n")) {
    const m = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
    if (m && Number(m[1]) === pgid && !IGNORE.has(m[2])) return true;
  }
  return false;
}

async function waitPort(port: number, ms: number, aborted: () => boolean) {
  const end = mono() + ms;
  while (mono() < end) {
    if (aborted()) return false;
    if (await portOpen(port)) return true;
    await sleep(120);
  }
  return false;
}

async function guiEnv(display: number, binDir?: string): Promise<NodeJS.ProcessEnv> {
  const bin = binDir ?? (await ensureBin());
  const xdg = `/tmp/wd-xdg-${process.getuid?.() ?? 0}`;
  await fsp.mkdir(xdg, { recursive: true, mode: 0o700 });
  const env = cleanEnv(bin) as unknown as NodeJS.ProcessEnv;
  Object.assign(env, {
    DISPLAY: `:${display}`,
    GDK_BACKEND: "x11",
    QT_QPA_PLATFORM: "xcb",
    WEBKIT_DISABLE_COMPOSITING_MODE: "1",
    WEBKIT_DISABLE_DMABUF_RENDERER: "1",
    LIBGL_ALWAYS_SOFTWARE: "1",
    GTK_USE_PORTAL: "0",
    NO_AT_BRIDGE: "1",
    XDG_RUNTIME_DIR: xdg,
    APPIMAGE_EXTRACT_AND_RUN: "1",
    MOZ_ENABLE_WAYLAND: "0",
    ELECTRON_OZONE_PLATFORM_HINT: "x11",
    _JAVA_AWT_WM_NONREPARENTING: "1",
  });
  delete env.WAYLAND_DISPLAY;
  return env;
}

/** 在已运行的浏览器里打开网址（新标签页）。Chromium 同一个配置目录只有一个实例，新进程会把网址交给它后退出 */
async function openUrlIn(g: Gui, url: string) {
  if (!/^https?:\/\//i.test(url) || url.length > 4000) throw new Error("网址无效");
  const env = await guiEnv(g.display);
  Object.assign(env, BROWSER_ENV);
  spawn("bash", ["-c", browserCommand(url)], { detached: true, stdio: "ignore", env }).unref();
}

async function startSession(g: Gui, delayMs = 0) {
  try {
    if (delayMs) await sleep(delayMs); // 等旧实例完全退出（单实例程序会检查旧实例）
    await ensureStack();
    if (g.stopped) return;
    if (g.preset === "browser") await ensureBrowserPkgs();
    if (g.stopped) return;
    g.state = "starting";
    g.note = "正在启动虚拟显示器…";
    await ensureHome();
    const binDir = await ensureBin();
    const rc = path.join(HOME, ".webdesktop", "openbox-rc.xml");
    await fsp.writeFile(rc, RC_XML);
    const xdg = `/tmp/wd-xdg-${process.getuid?.() ?? 0}`;
    await fsp.mkdir(xdg, { recursive: true, mode: 0o700 });

    const display = await pickDisplay(g);
    const env = await guiEnv(display, binDir);
    if (g.preset === "browser") Object.assign(env, BROWSER_ENV);

    const xvnc = spawn(
      "Xvnc",
      [
        `:${display}`,
        "-geometry",
        `${g.w}x${g.h}`,
        "-depth",
        "24",
        "-rfbport",
        String(g.port),
        "-SecurityTypes",
        "None",
        "-localhost",
        "-AlwaysShared",
        // —— 远程画面稳定性 / 延迟优化 ——
        // 默认 60fps 会在高延迟链路上持续灌满带宽：画面排队积压，用户感受到的就是「延迟很高」。
        // 30fps 对桌面应用完全够用，且把瞬时码率减半，排队时间随之减半。
        "-FrameRate",
        "30",
        // 强制逐像素比对帧缓冲：只发真正变化的区域。
        // 默认 "auto" 在负载高时会关掉比对，于是大量「内容没变但被标记为脏」的区域被反复重发——
        // 这正是画面「闪烁」的主要来源。固定为 1（始终比对）用一点 CPU 换掉绝大部分无效重绘。
        "-CompareFB",
        "1",
        // 永不因「空闲」或「没人连」而自杀：网页端重连期间会话必须存活，否则就变成反复重启。
        "-IdleTimeout",
        "0",
        "-MaxIdleTime",
        "0",
        "-MaxDisconnectionTime",
        "0",
        "-nolisten",
        "tcp",
        "-desktop",
        g.name || "app",
      ],
      { detached: true, stdio: ["ignore", "pipe", "pipe"], env },
    ) as ChildProcess;
    g.xvnc = xvnc;
    xvnc.stdout?.on("data", (d) => append(g, d));
    xvnc.stderr?.on("data", (d) => append(g, d));
    xvnc.on("exit", () => {
      if (!g.stopped && g.state !== "exited" && g.state !== "failed") {
        finish(g, "failed", "虚拟显示器意外退出");
      }
    });
    if (!(await waitPort(g.port, 15_000, () => g.stopped || xvnc.exitCode !== null))) {
      if (g.stopped) return;
      throw new Error(`虚拟显示器启动失败：${g.log.slice(-300).trim()}`);
    }

    // AppImage 需要可执行权限
    const first = /^(?:'([^']+)'|"([^"]+)"|(\S+))/.exec(g.exec);
    const bin = first?.[1] ?? first?.[2] ?? first?.[3];
    if (bin && /\.AppImage$/i.test(bin)) await fsp.chmod(bin, 0o755).catch(() => {});

    const script = [
      'openbox --config-file "$1" >/dev/null 2>&1 &',
      "sleep 0.5",
      'cd "$3" 2>/dev/null || cd "$HOME"',
      'exec bash -c "$2"',
    ].join("\n");
    const hasDbus = await hasBin("dbus-run-session");
    const [prog, args] = hasDbus
      ? (["dbus-run-session", ["--", "bash", "-c", script, "wd", rc, g.exec, g.cwd]] as const)
      : (["bash", ["-c", script, "wd", rc, g.exec, g.cwd]] as const);
    const app: ChildProcess = spawn(prog, [...args], { detached: true, stdio: ["ignore", "pipe", "pipe"], env });
    g.app = app;
    app.stdout?.on("data", (d) => append(g, d));
    app.stderr?.on("data", (d) => append(g, d));
    app.on("error", (e) => finish(g, "failed", `无法启动程序：${e.message}`));
    app.on("exit", (code, signal) => {
      g.exitCode = code ?? (signal ? 137 : 0);
      const pgid = app.pid ?? 0;
      // 有些程序会把自己放到后台再退出启动器：只要进程组里还有其他进程，就继续保持会话
      void (async () => {
        while (!g.stopped && g.state === "running" && pgid && (await groupBusy(pgid))) await sleep(1500);
        if (!g.stopped) finish(g, "exited");
      })();
    });
    if (!g.stopped) {
      g.state = "running";
      g.note = "";
      if (G.clip) {
        void applyClipToDisplay(g.display, G.clip).catch(() => {});
      }
    }
  } catch (e) {
    finish(g, "failed", e instanceof Error ? e.message : "启动失败");
  }
}

// 服务重启后，上一次运行遗留的虚拟显示器已经没人管了：先清理掉，应用会随之退出
async function cleanOrphans() {
  if (G.cleaned) return;
  G.cleaned = true;
  const r = await run("pkill", ["-f", "^Xvnc :[0-9]+ -geometry [0-9x]+ -depth 24 -rfbport [0-9]+ -SecurityTypes None -localhost"], 5000);
  if (r.code === 0) await sleep(2200); // 找到并结束了孤儿：等它们的程序完全退出
}

function ensureTimer() {
  if (G.timer) return;
  G.timer = setInterval(() => {
    const now = mono();
    for (const g of [...G.sessions.values()]) {
      if (g.state === "running" && g.clients === 0 && now - g.lastSeen > IDLE_MS) stopGui(g.id, "idle");
      else if ((g.state === "exited" || g.state === "failed") && now - g.endedAt > 5 * 60_000) stopGui(g.id, "ended-cleanup");
    }
  }, 10_000);
  G.timer.unref?.();
}

export type GuiOpts = {
  exec?: string;
  desktopFile?: string;
  cwd?: string;
  name?: string;
  w?: number;
  h?: number;
  preset?: string;
  url?: string;
  sidHint?: string;
};

export async function createGui(o: GuiOpts): Promise<{ g: Gui; reused: boolean }> {
  const isBrowser = o.preset === "browser";
  if (isBrowser) {
    // 浏览器只开一个：已经在运行就直接复用（刷新页面后能接回原来的标签页），并把网址交给它
    const existing = [...G.sessions.values()].find((x) => x.preset === "browser" && x.state !== "exited" && x.state !== "failed");
    if (existing) {
      // 从共享桌面快照重连时保持原有标签页和当前画面，不重复打开旧 URL。
      if (o.url && !o.sidHint) await openUrlIn(existing, o.url);
      existing.lastSeen = mono();
      return { g: existing, reused: true };
    }
  }
  await cleanOrphans();
  let exec = (o.exec ?? "").trim();
  let name = (o.name ?? "").trim();
  let cwd = (o.cwd ?? "").trim() || HOME;
  if (isBrowser) {
    exec = browserCommand(o.url);
    name = "浏览器";
    cwd = HOME;
  }
  if (o.desktopFile) {
    const f = o.desktopFile;
    if (!path.isAbsolute(f) || !f.endsWith(".desktop") || f.includes("..")) throw new Error("启动文件路径无效");
    const text = await fsp.readFile(f, "utf8").catch(() => {
      throw new Error("找不到应用启动文件");
    });
    const e = parseDesktop(f, text);
    if (!e) throw new Error("不是有效的应用启动文件");
    exec = e.exec;
    name = name || e.name;
    if (e.cwd) cwd = e.cwd;
  }
  if (!exec || exec.length > 4000 || /\0/.test(exec)) throw new Error("命令无效");
  if (!path.isAbsolute(cwd)) cwd = HOME;
  const previous = o.sidHint ? G.sessions.get(o.sidHint) : undefined;
  if (previous && previous.exec === exec && !previous.stopped && previous.state !== "exited" && previous.state !== "failed") {
    previous.lastSeen = mono();
    return { g: previous, reused: true };
  }
  if ([...G.sessions.values()].filter((g) => g.state !== "exited" && g.state !== "failed").length >= MAX_SESSIONS) {
    throw new Error("图形应用窗口过多，请先关闭一个");
  }
  // 同一个程序已经有一个没人连接的会话（比如刷新页面后残留）：先替换掉它，避免单实例程序拒绝新实例
  let replaced = false;
  for (const old of [...G.sessions.values()]) {
    if (old.exec === exec && old.clients === 0 && old.state !== "exited" && old.state !== "failed") {
      stopGui(old.id, "replaced");
      replaced = true;
    }
  }
  const g: Gui = {
    id: Math.random().toString(36).slice(2) + Date.now().toString(36),
    name: (name || exec.split(/\s+/)[0].split("/").pop() || "应用").slice(0, 80),
    exec,
    cwd,
    w: clamp(o.w, 320, 4000, 1024),
    h: clamp(o.h, 240, 4000, 640),
    state: "preparing",
    note: "",
    log: "",
    exitCode: null,
    display: -1,
    port: 0,
    xvnc: null,
    app: null,
    clients: 0,
    lastSeen: mono(),
    endedAt: 0,
    stopped: false,
    preset: isBrowser ? "browser" : "",
    rtt: 0,
    stalls: 0,
  };
  G.sessions.set(g.id, g);
  ensureTimer();
  // 上一个浏览器刚关闭：等它把配置目录释放掉再启动，否则新进程会把网址交给正在退出的旧进程
  const sinceStop = mono() - G.lastBrowserStop;
  const delay = Math.max(replaced ? 2200 : 0, isBrowser && sinceStop < 4000 ? 4000 - sinceStop : 0);
  void startSession(g, delay);
  return { g, reused: false };
}

export function getGui(id: string) {
  return G.sessions.get(id);
}

export function stopGui(id: string, reason = "client") {
  const g = G.sessions.get(id);
  if (!g) return;
  console.log(`${stamp()} [gui] stop ${id} (${g.preset || g.exec}) display=:${g.display} reason=${reason}`);
  const ended = (G.ended ??= new Map());
  ended.set(id, reason);
  if (ended.size > 50) ended.delete(ended.keys().next().value as string);
  g.stopped = true;
  G.sessions.delete(id);
  g.state = g.state === "failed" ? "failed" : "exited";
  if (g.preset === "browser") G.lastBrowserStop = mono();
  killGroup(g.app);
  setTimeout(() => killGroup(g.xvnc), g.preset ? 1500 : 0);
  setTimeout(() => {
    void fsp.rm(`/tmp/.X${g.display}-lock`, { force: true });
    void fsp.rm(`/tmp/.X11-unix/X${g.display}`, { force: true });
  }, 2000).unref?.();
}

/** 会话为什么不存在了（client=网页关闭/刷新/点了重新启动，idle=断线太久被回收，auth-expired=登录失效，replaced=被同名新窗口替换） */
export function endedReason(id: string) {
  return G.ended?.get(id) ?? "unknown";
}

export function statusOf(g: Gui) {
  g.lastSeen = mono();
  return {
    state: g.state,
    note: g.state === "preparing" ? G.stackNote || g.note : g.note,
    log: g.log.slice(-4000),
    exitCode: g.exitCode,
    name: g.name,
    rtt: Math.round(g.rtt),
    stalls: g.stalls,
  };
}

/* ---------------- WebSocket：把 VNC 的 TCP 连接转成 WebSocket ---------------- */

const rawToBuffer = (d: RawData) => (Buffer.isBuffer(d) ? d : Array.isArray(d) ? Buffer.concat(d) : Buffer.from(d));

export function guiUpgrade(wss: WebSocketServer, req: http.IncomingMessage, socket: Duplex, head: Buffer, url: URL) {
  const g = G.sessions.get(url.searchParams.get("sid") ?? "");
  if (!g || g.state !== "running") {
    socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
    (socket as net.Socket).setNoDelay?.(true);
    const tcp = net.connect({ host: "localhost", port: g.port });
    tcp.setNoDelay(true);
    g.clients++;
    g.lastSeen = mono();
    let gone = false;
    const ip = String(req.headers["x-forwarded-for"] ?? req.socket.remoteAddress ?? "?").split(",")[0].trim();
    console.log(`${stamp()} [gui] ws open ${g.id} clients=${g.clients} ip=${ip}`);

    // 心跳有两个作用：
    //  1) 保活。画面静止时 VNC 一个字节都不发，而多数网关/反代会掐掉空闲 30–60 秒的连接。
    //     原来 25 秒一次的间隔在抖动下已经压线，连接被掐断 → 网页重连 → 画面重新传一屏 = 用户看到的「周期性闪烁 / 重连」。
    //     改成 10 秒，稳稳压在常见的 30 秒空闲阈值之下。
    //  2) 实测往返延迟（RTT），网页端据此自动调画质，这样「延迟高」时不会继续用高码率把链路撑爆。
    let missed = 0;
    let pingAt = 0;
    ws.on("pong", () => {
      missed = 0;
      if (!pingAt) return;
      const sample = Date.now() - pingAt;
      pingAt = 0;
      // 指数平滑，避免个别抖动把画质档位带偏
      g.rtt = g.rtt ? g.rtt * 0.7 + sample * 0.3 : sample;
    });
    const pingTimer = setInterval(() => {
      if (ws.readyState !== ws.OPEN) return;
      // 6 次（约 60 秒）都没有任何回应才判定对端已死。
      // 原来 3 次 × 25 秒的组合里，单次网络抖动就可能凑够次数被误杀，导致毫无必要的重连。
      if (++missed > 6) {
        ws.terminate();
        cleanup("ping-timeout");
        return;
      }
      pingAt = Date.now();
      ws.ping();
    }, 10_000);

    const cleanup = (why = "?") => {
      if (gone) return;
      gone = true;
      console.log(`${stamp()} [gui] ws close ${g.id} by=${why} clients=${Math.max(0, g.clients - 1)}`);
      clearInterval(authTimer);
      clearInterval(pingTimer);
      g.clients = Math.max(0, g.clients - 1);
      g.lastSeen = mono();
      tcp.destroy();
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    };

    // 登录失效（密码到期 / 强制下线）时立即断开并结束这个应用
    const authTimer = setInterval(() => {
      void desktopAuthState(req.headers.cookie, url.searchParams.get("access")).then((ok) => {
        if (ok !== false || gone) return;
        // 只断开旧网页，不结束正在运行的图形进程；新页面可接回同一画面。
        try {
          ws.close(4001, "auth");
        } catch {
          /* ignore */
        }
      });
      // 每 5 秒校验一次，旧页面被接管后无法继续操控 VNC。
    }, 5000);

    // 发送积压控制。
    // 原来的阈值是「积压到 4MB 才暂停」：在一条 2Mbps 的链路上，4MB 意味着排着 16 秒的陈旧画面，
    // 用户的每一次点击都要等这堆旧帧传完才看得到反应 —— 这就是「延迟太高」的真正来源。
    // 把水位压到 256KB：一旦超过就停止从 Xvnc 读数据，Xvnc 的待发更新会自动合并
    //（VNC 是状态式协议，中间帧被合并掉完全无损），恢复读取时直接拿到「最新」的画面而不是一串过期帧。
    const HI = 256 * 1024;
    const LO = 64 * 1024;
    let draining = false;
    const drain = () => {
      if (ws.bufferedAmount < LO || ws.readyState !== ws.OPEN || gone) {
        draining = false;
        if (!gone) tcp.resume();
        return;
      }
      setTimeout(drain, 15);
    };
    tcp.on("data", (d) => {
      if (ws.readyState !== ws.OPEN) return;
      ws.send(d, { binary: true });
      // 加 draining 守卫：原来每个 data 事件都会再起一个定时器，积压时会叠出几十个计时器互相抢着 resume
      if (!draining && ws.bufferedAmount > HI) {
        draining = true;
        g.stalls++;
        tcp.pause();
        setTimeout(drain, 15);
      }
    });
    tcp.on("close", () => cleanup("xvnc-closed"));
    tcp.on("error", () => cleanup("xvnc-error"));
    let ctrlDown = false;
    ws.on("message", (d) => {
      g.lastSeen = mono();
      ctrlDown = logImeKeys(g.id, rawToBuffer(d), ctrlDown);
      if (tcp.writable) tcp.write(rawToBuffer(d));
    });
    ws.on("close", (code) => cleanup(`browser-closed(code=${code})`));
    ws.on("error", () => cleanup("browser-error"));
  });
}

// 诊断用：从网页发来的 VNC 消息里找出 Shift / Ctrl / Ctrl+空格 按键并记日志，用来排查"输入法切换不了"。
// 不记录其他任何按键。消息可能被合并在一帧里，按 RFB 客户端消息格式逐条解析，遇到不认识的类型就停。
const KEY_NAMES: Record<number, string> = { 0xffe1: "Shift_L", 0xffe2: "Shift_R", 0xffe3: "Control_L", 0xffe4: "Control_R" };
function logImeKeys(id: string, b: Buffer, ctrl: boolean): boolean {
  let o = 0;
  while (o < b.length) {
    const t = b[o];
    let n = 0;
    if (t === 4 && o + 8 <= b.length) {
      const down = b[o + 1] === 1;
      const sym = b.readUInt32BE(o + 4);
      const name = KEY_NAMES[sym] ?? (sym === 0x20 && ctrl ? "space(with Ctrl)" : "");
      if (sym === 0xffe3 || sym === 0xffe4) ctrl = down;
      if (name) console.log(`${stamp()} [gui] key ${id} ${name} ${down ? "down" : "up"}`);
      n = 8;
    } else if (t === 5) n = 6;
    else if (t === 3 || t === 150) n = 10;
    else if (t === 0) n = 20;
    else if (t === 2 && o + 4 <= b.length) n = 4 + 4 * b.readUInt16BE(o + 2);
    else if (t === 6 && o + 8 <= b.length) n = 8 + (b.readInt32BE(o + 4) >= 0 ? b.readInt32BE(o + 4) : -b.readInt32BE(o + 4));
    else if (t === 251 && o + 8 <= b.length) n = 8 + 16 * b[o + 6];
    else break;
    o += n;
  }
  return ctrl;
}

export async function openUrl(g: { preset: string; display: number } & Record<string, unknown>, url: string) {
  if (g.preset !== "browser") throw new Error("这不是浏览器会话");
  await openUrlIn(g as unknown as Gui, url);
}

function toPngWithImageMagick(data: Buffer) {
  return new Promise<Buffer>((resolve, reject) => {
    const p = spawn("convert", ["-", "png:-"], { stdio: ["pipe", "pipe", "ignore"] });
    const out: Buffer[] = [];
    p.stdout!.on("data", (d: Buffer) => out.push(d));
    p.on("error", () => reject(new Error("图片无法读取或格式已损坏")));
    p.on("exit", (code) => (code === 0 && out.length ? resolve(Buffer.concat(out)) : reject(new Error("图片无法读取或格式已损坏"))));
    p.stdin!.on("error", () => {});
    p.stdin!.end(data);
  });
}

const CLIP_TMP_DIR = "/tmp/wd-clip-files";
const IMG_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;

async function ensurePngForFile(filePath: string): Promise<string | undefined> {
  if (!IMG_EXT_RE.test(filePath)) return undefined;
  try {
    const st = await fsp.stat(filePath);
    if (!st.isFile() || st.size > 32 * 1024 * 1024) return undefined;
    if (/\.png$/i.test(filePath)) return filePath;
    await fsp.mkdir(CLIP_TMP_DIR, { recursive: true });
    const outPath = path.join(CLIP_TMP_DIR, `conv-${ path.basename(filePath, path.extname(filePath)) }-${Math.round(st.mtimeMs)}.png`);
    try {
      await fsp.access(outPath);
      return outPath;
    } catch {
      /* need convert */
    }
    const raw = await fsp.readFile(filePath);
    const sharp = (await import("sharp")).default;
    const pngBuf = await sharp(raw, { animated: false })
      .png()
      .toBuffer()
      .catch(() => toPngWithImageMagick(raw));
    await fsp.writeFile(outPath, pngBuf);
    return outPath;
  } catch {
    return undefined;
  }
}

export async function prepareClipPayload(paths: string[], cut = false, textOverride?: string): Promise<ServerClip> {
  const validPaths: string[] = [];
  for (const p of paths) {
    try {
      await fsp.lstat(p);
      validPaths.push(p);
    } catch {
      /* ignore missing */
    }
  }
  if (!validPaths.length && !textOverride) {
    throw new Error("要复制的文件不存在");
  }
  let pngPath: string | undefined;
  if (validPaths.length === 1) {
    pngPath = await ensurePngForFile(validPaths[0]);
  }
  const formattedPaths = validPaths.map((p) => (/\s/.test(p) ? `"${p}"` : p)).join(" ");
  return {
    kind: pngPath ? "image" : validPaths.length ? "files" : "text",
    paths: validPaths,
    cut,
    pngPath,
    text: textOverride ?? formattedPaths,
    ts: Date.now(),
  };
}

/**
 * 将剪贴板数据应用到指定虚拟显示器 (DISPLAY=:display)
 * 同时提供 image/png、x-special/gnome-copied-files、text/uri-list、UTF8_STRING 等多种目标格式，
 * 使得 VNC 内的浏览器、文件管理器 (PCManFM/Thunar/Nautilus)、聊天/图像软件及终端均能直接粘贴文件或图片。
 */
export async function applyClipToDisplay(display: number, clip: ServerClip): Promise<void> {
  if (display < 0) return;
  const binDir = await ensureBin();
  const env = await guiEnv(display, binDir);
  const clipProcs = (G.clipProcs ??= new Map());
  const prev = clipProcs.get(display);
  if (prev && prev.exitCode === null) {
    try {
      prev.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    clipProcs.delete(display);
  }

  const scriptPath = path.join(binDir, "wd-clip.py");
  const ok = await new Promise<boolean>((resolve) => {
    const p = spawn("python3", [scriptPath], {
      detached: true,
      stdio: ["pipe", "pipe", "ignore"],
      env,
    });
    clipProcs.set(display, p);
    let settled = false;
    const finish = (v: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      p.stdout?.removeAllListeners();
      p.unref?.();
      resolve(v);
    };
    const timer = setTimeout(() => finish(false), 2500);
    let out = "";
    p.stdout?.on("data", (d: Buffer) => {
      out += d.toString("utf8");
      if (out.includes("READY")) finish(true);
    });
    p.on("error", () => finish(false));
    p.on("exit", () => finish(false));
    try {
      p.stdin?.end(JSON.stringify(clip));
    } catch {
      finish(false);
    }
  });

  if (ok) return;

  // 回退方案：使用 xclip 写入
  if (clip.pngPath) {
    const pngData = await fsp.readFile(clip.pngPath);
    await new Promise<void>((resolve, reject) => {
      const p = spawn("xclip", ["-selection", "clipboard", "-t", "image/png", "-i"], {
        detached: true,
        stdio: ["pipe", "ignore", "ignore"],
        env,
      });
      p.on("error", () => reject(new Error("缺少 xclip")));
      p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error("写入剪贴板失败"))));
      p.stdin!.end(pngData);
    });
  } else if (clip.text) {
    await new Promise<void>((resolve, reject) => {
      const p = spawn("xclip", ["-selection", "clipboard", "-i"], {
        detached: true,
        stdio: ["pipe", "ignore", "ignore"],
        env,
      });
      p.on("error", () => reject(new Error("缺少 xclip")));
      p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error("写入剪贴板失败"))));
      p.stdin!.end(clip.text);
    });
  }
}

async function runXdo(display: number, args: string[]) {
  const env = await guiEnv(display);
  await new Promise<void>((resolve, reject) => {
    const p = spawn("xdotool", args, { stdio: "ignore", env });
    p.on("error", () => reject(new Error("缺少 xdotool，请先安装：sudo apt-get install xdotool")));
    p.on("exit", () => resolve());
  });
}

/** 设置全局服务器剪贴板（从模拟桌面或文件管理器复制/剪切文件或图片），并同步到所有运行中的 VNC 会话 */
export async function setServerClipFiles(paths: string[], cut = false): Promise<ServerClip> {
  const clip = await prepareClipPayload(paths, cut);
  G.clip = clip;
  const tasks: Promise<void>[] = [];
  for (const s of G.sessions.values()) {
    if (s.state === "running" && s.display >= 0) {
      tasks.push(applyClipToDisplay(s.display, clip).catch(() => {}));
    }
  }
  await Promise.all(tasks);
  return clip;
}

export function getServerClip(): ServerClip | null {
  return G.clip ?? null;
}

/** 读取运行中的 VNC 会话剪贴板（若用户在 VNC 内部复制了文件或图片，可粘贴回模拟桌面） */
export async function readVncClipboard(): Promise<ServerClip | null> {
  const running = [...G.sessions.values()]
    .filter((s) => s.state === "running" && s.display >= 0)
    .sort((a, b) => b.lastSeen - a.lastSeen);
  const binDir = await ensureBin();
  const scriptPath = path.join(binDir, "wd-clip.py");
  for (const s of running) {
    try {
      const env = await guiEnv(s.display, binDir);
      const res = await new Promise<ServerClip | null>((resolve) => {
        execFile("python3", [scriptPath, "--get"], { env, timeout: 2500 }, (err, stdout) => {
          if (err || !stdout) return resolve(null);
          try {
            const parsed = JSON.parse(String(stdout).trim()) as {
              kind?: string;
              paths?: string[];
              pngPath?: string;
              cut?: boolean;
              text?: string;
            };
            if (parsed.kind === "files" && parsed.paths?.length) {
              return resolve({
                kind: "files",
                paths: parsed.paths,
                cut: !!parsed.cut,
                ts: Date.now(),
              });
            }
            if (parsed.kind === "image" && parsed.pngPath) {
              return resolve({
                kind: "image",
                paths: [parsed.pngPath],
                pngPath: parsed.pngPath,
                cut: false,
                ts: Date.now(),
              });
            }
          } catch {
            /* ignore */
          }
          resolve(null);
        });
      });
      if (res) return res;
    } catch {
      /* next session */
    }
  }
  return G.clip ?? null;
}

/** 将服务器上的文件或图片写入指定 VNC 会话剪贴板，可选立即触发 Ctrl+V 粘贴 */
export async function setClipboardFilesForSession(
  g: { display: number },
  paths: string[],
  cut = false,
  triggerPaste = false,
): Promise<ServerClip> {
  const clip = await prepareClipPayload(paths, cut);
  G.clip = clip;
  await applyClipToDisplay(g.display, clip);
  if (triggerPaste) {
    await sleep(60);
    await runXdo(g.display, ["key", "--clearmodifiers", "ctrl+v"]);
  }
  return clip;
}

/** 触发指定 VNC 会话执行粘贴（如果服务端有已复制的文件/图片，先确保同步到该显示器） */
export async function triggerVncPaste(g: { display: number }, x?: number, y?: number) {
  if (G.clip) {
    await applyClipToDisplay(g.display, G.clip);
  }
  if (Number.isFinite(x) && Number.isFinite(y)) {
    await runXdo(g.display, ["mousemove", String(Math.round(x!)), String(Math.round(y!)), "click", "1"]);
    await sleep(120);
  }
  await runXdo(g.display, ["key", "--clearmodifiers", "ctrl+v"]);
}

/** 把上传的图片或任意文件写入会话的 X 剪贴板（同时支持 image/png、text/uri-list、x-special/gnome-copied-files、UTF8_STRING） */
export async function setClipboardUploadedFile(
  g: { display: number },
  data: Buffer,
  mime: string,
  filename?: string,
  triggerPaste = false,
  x?: number,
  y?: number,
) {
  await fsp.mkdir(CLIP_TMP_DIR, { recursive: true });
  const isImg = /^image\/(png|jpeg|gif|webp|bmp|svg\+xml)$/.test(mime) || (filename ? IMG_EXT_RE.test(filename) : false);
  let safeName = (filename ?? "").replace(/[/\\\0]/g, "_").trim();
  if (!safeName) {
    const ext = isImg ? "png" : mime.split("/")[1]?.replace(/[^a-z0-9]/gi, "") || "bin";
    safeName = `粘贴的文件-${Date.now()}.${ext}`;
  }
  let fileData = data;
  if (isImg && mime !== "image/png" && !/\.png$/i.test(safeName)) {
    const sharp = (await import("sharp")).default;
    const src = data;
    fileData = await sharp(src, { animated: false })
      .png()
      .toBuffer()
      .catch(() => toPngWithImageMagick(src));
    safeName = safeName.replace(/\.[^.]+$/, "") + ".png";
  }
  const savedPath = path.join(CLIP_TMP_DIR, `${Date.now()}-${safeName}`);
  await fsp.writeFile(savedPath, fileData);

  const clip: ServerClip = {
    kind: isImg ? "image" : "files",
    paths: [savedPath],
    cut: false,
    pngPath: isImg ? savedPath : undefined,
    text: /\s/.test(savedPath) ? `"${savedPath}"` : savedPath,
    ts: Date.now(),
  };
  G.clip = clip;
  await applyClipToDisplay(g.display, clip);

  if (Number.isFinite(x) && Number.isFinite(y)) {
    await runXdo(g.display, ["mousemove", String(Math.round(x!)), String(Math.round(y!)), "click", "1"]);
    await sleep(120);
  }
  if (triggerPaste || (Number.isFinite(x) && Number.isFinite(y))) {
    await sleep(60);
    await runXdo(g.display, ["key", "--clearmodifiers", "ctrl+v"]);
  }
  return clip;
}

/** 把一张图片放进会话的 X 剪贴板（兼容原有调用，并同时提供文件 URI 与图片格式） */
export async function setClipboardImage(g: { display: number }, data: Buffer, mime: string) {
  if (!/^image\/(png|jpeg|gif|webp|bmp)$/.test(mime)) throw new Error("不支持的图片格式");
  await setClipboardUploadedFile(g, data, mime, `剪贴板图片-${Date.now()}.png`, false);
}

/**
 * 把服务器上的文件或图片"拖"进或粘贴进应用：
 * 同时在 X11 剪贴板设置 image/png（若是图片）、x-special/gnome-copied-files、text/uri-list 和文件路径文字，
 * 随后在松手位置点击并发送 Ctrl+V，使支持图片粘贴、文件粘贴或路径粘贴的 VNC 应用都能直接接收。
 */
export async function dropFile(g: { display: number }, file: string, x: number, y: number) {
  await fsp.stat(file); // 文件不存在就报错
  const clip = await prepareClipPayload([file], false, `${/\s/.test(file) ? `"${file}"` : file} `);
  G.clip = clip;
  await applyClipToDisplay(g.display, clip);
  await runXdo(g.display, ["mousemove", String(Math.round(x)), String(Math.round(y)), "click", "1"]);
  await sleep(150);
  await runXdo(g.display, ["key", "--clearmodifiers", "ctrl+v"]);
  return { path: file, kind: clip.kind };
}
