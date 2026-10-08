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
};
const holder = globalThis as unknown as { __wdGui?: Store };
const G: Store = (holder.__wdGui ??= { sessions: new Map(), stackNote: "", pick: Promise.resolve(), lastBrowserStop: -1e9 });
G.lastBrowserStop ??= -1e9;

const MAX_SESSIONS = 4;
// 没有任何网页连着时，应用多保留多久（网页端会在这段时间内自动重连）。
// 所有"空闲"计时都用单调时钟：本机会被平台整机冻结（可达数小时），恢复时墙钟（Date.now）会一次跳过去，
// 但单调时钟不走，冻结的时间不该算作"没人连"。
const IDLE_MS = 30 * 60_000;
const mono = () => performance.now();
const stamp = () => new Date().toISOString();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clamp = (v: unknown, lo: number, hi: number, d: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : d;
};

/* ---------------- 图形环境：首次使用时自动安装 ---------------- */

const NEED_BINS = ["Xvnc", "openbox", "dbus-run-session"];
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
};

export async function createGui(o: GuiOpts): Promise<{ g: Gui; reused: boolean }> {
  const isBrowser = o.preset === "browser";
  if (isBrowser) {
    // 浏览器只开一个：已经在运行就直接复用（刷新页面后能接回原来的标签页），并把网址交给它
    const existing = [...G.sessions.values()].find((x) => x.preset === "browser" && x.state !== "exited" && x.state !== "failed");
    if (existing) {
      if (o.url) await openUrlIn(existing, o.url);
      existing.lastSeen = mono();
      return { g: existing, reused: true };
    }
  }
  if ([...G.sessions.values()].filter((g) => g.state !== "exited" && g.state !== "failed").length >= MAX_SESSIONS) {
    throw new Error("图形应用窗口过多，请先关闭一个");
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
    console.log(`${stamp()} [gui] ws open ${g.id} clients=${g.clients}`);

    const pingTimer = setInterval(() => {
      if (ws.readyState === ws.OPEN) ws.ping();
    }, 25_000);

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
      void desktopAuthState(req.headers.cookie).then((ok) => {
        if (ok !== false || gone) return;
        stopGui(g.id, "auth-expired");
        try {
          ws.close(4001, "auth");
        } catch {
          /* ignore */
        }
      });
    }, 5000);

    tcp.on("data", (d) => {
      if (ws.readyState !== ws.OPEN) return;
      ws.send(d, { binary: true });
      if (ws.bufferedAmount > 4 * 1024 * 1024) {
        tcp.pause();
        const t = setInterval(() => {
          if (ws.bufferedAmount < 512 * 1024 || ws.readyState !== ws.OPEN) {
            clearInterval(t);
            tcp.resume();
          }
        }, 20);
      }
    });
    tcp.on("close", () => cleanup("xvnc-closed"));
    tcp.on("error", () => cleanup("xvnc-error"));
    ws.on("message", (d) => {
      g.lastSeen = mono();
      if (tcp.writable) tcp.write(rawToBuffer(d));
    });
    ws.on("close", (code) => cleanup(`browser-closed(code=${code})`));
    ws.on("error", () => cleanup("browser-error"));
  });
}

export async function openUrl(g: { preset: string; display: number } & Record<string, unknown>, url: string) {
  if (g.preset !== "browser") throw new Error("这不是浏览器会话");
  await openUrlIn(g as unknown as Gui, url);
}

/** 把一张图片放进会话的 X 剪贴板（xclip 会留在后台持有剪贴板，直到下次被替换） */
export async function setClipboardImage(g: { display: number }, data: Buffer, mime: string) {
  if (!/^image\/(png|jpeg|gif|webp|bmp)$/.test(mime)) throw new Error("不支持的图片格式");
  const env = await guiEnv(g.display);
  await new Promise<void>((resolve, reject) => {
    const p = spawn("xclip", ["-selection", "clipboard", "-t", mime, "-i"], { detached: true, stdio: ["pipe", "ignore", "ignore"], env });
    p.on("error", () => reject(new Error("缺少 xclip，请先安装：sudo apt-get install xclip")));
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error("写入剪贴板失败"))));
    p.stdin!.end(data);
  });
}
