import { execFile, spawn } from "child_process";
import fsp from "fs/promises";
import path from "path";
import { chromium, type BrowserContext, type CDPSession, type Page } from "playwright-core";
import { DOWNLOADS, HOME, ensureHome, exists } from "@/lib/sys";

// 服务器上运行真实的 Chromium，把画面推送给网页窗口，并转发鼠标键盘。
// 所有状态放在 globalThis 上，避免被打包成多份模块实例。

export type Tab = {
  id: number;
  page: Page;
  cdp: CDPSession | null;
  title: string;
  url: string;
  loading: boolean;
  back: boolean;
  fwd: boolean;
};

export type BEvent = { id: number; kind: "info" | "error"; text: string };

export type Session = {
  id: string;
  tabs: Tab[];
  active: number;
  castTab: Tab | null;
  w: number;
  h: number;
  frame: Buffer | null;
  seq: number;
  frameWaiters: Set<() => void>;
  metaV: number;
  metaWaiters: Set<() => void>;
  events: BEvent[];
  evSeq: number;
  lastSeen: number;
  closed: boolean;
  chain: Promise<unknown>;
  buttons: number;
  frameY: number;
  lastFrameAt: number;
};

type Global = {
  ctx?: Promise<BrowserContext>;
  spare?: Page;
  sessions: Map<string, Session>;
  tabSeq: number;
  creating: number;
  lastActive?: Session;
  timer?: NodeJS.Timeout;
  starting?: string;
};

const holder = globalThis as unknown as { __wdBrowser?: Global };
const G: Global = (holder.__wdBrowser ??= { sessions: new Map(), tabSeq: 0, creating: 0 });

const PROFILE = path.join(HOME, ".webdesktop", "browser-profile");
const MAX_SESSIONS = 3;
const IDLE_MS = 90_000;
const CAST_QUALITY = 70;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clamp = (v: unknown, lo: number, hi: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo;
};

/* ---------------- 浏览器内核启动 / 自动安装 ---------------- */

function runCli(args: string[], sudo = false) {
  const cli = path.join(process.cwd(), "node_modules", "playwright-core", "cli.js");
  return new Promise<void>((resolve, reject) => {
    const cmd = sudo ? "sudo" : process.execPath;
    const argv = sudo ? ["-n", process.execPath, cli, ...args] : [cli, ...args];
    const p = spawn(cmd, argv, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, HOME } });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("error", reject);
    p.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`playwright ${args.join(" ")} 失败: ${out.slice(-300)}`)),
    );
  });
}

function killOrphans() {
  return new Promise<void>((resolve) => {
    execFile("pkill", ["-f", `user-data-dir=${PROFILE}`], () => resolve());
  });
}

async function ensureFonts() {
  const has = await new Promise<boolean>((resolve) =>
    execFile("fc-list", [":lang=zh"], (err, out) => resolve(!err && out.trim().length > 0)),
  );
  if (has) return;
  G.starting = "正在安装中文字体（首次使用）…";
  await new Promise<void>((resolve) =>
    execFile(
      "sudo",
      ["-n", "env", "DEBIAN_FRONTEND=noninteractive", "apt-get", "install", "-y", "-q", "fonts-noto-cjk", "fonts-noto-color-emoji"],
      { timeout: 240_000 },
      () => resolve(),
    ),
  );
}

async function launch(): Promise<BrowserContext> {
  await fsp.mkdir(PROFILE, { recursive: true });
  await ensureFonts();
  await killOrphans();
  await sleep(300);
  for (const f of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
    await fsp.rm(path.join(PROFILE, f), { force: true }).catch(() => {});
  }
  let installed = false;
  let deps = false;
  for (let i = 0; i < 4; i++) {
    try {
      const ctx = await chromium.launchPersistentContext(PROFILE, {
        headless: true,
        viewport: { width: 1024, height: 640 },
        locale: "zh-CN",
        acceptDownloads: true,
        ignoreHTTPSErrors: true,
        args: [
          "--disable-blink-features=AutomationControlled",
          "--disable-dev-shm-usage",
          "--lang=zh-CN",
          "--hide-scrollbars=false",
          "--disable-smooth-scrolling",
        ],
      });
      await ctx.addInitScript(() => {
        Object.defineProperty(navigator, "webdriver", { get: () => undefined });
        const w = window as unknown as { chrome?: unknown };
        if (!w.chrome) w.chrome = { runtime: {} };
      });
      ctx.on("page", (page) => void onPopup(page));
      ctx.on("close", () => {
        G.ctx = undefined;
        G.spare = undefined;
        for (const s of [...G.sessions.values()]) dropSession(s);
      });
      const first = ctx.pages()[0];
      if (first) G.spare = first;
      G.starting = undefined;
      return ctx;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!installed && /Executable doesn't exist|playwright install/i.test(msg)) {
        installed = true;
        G.starting = "正在下载浏览器内核（首次使用，约 1 分钟）…";
        await runCli(["install", "chromium"]);
        continue;
      }
      if (!deps && /shared libraries|install-deps|missing dependencies|Host system is missing/i.test(msg)) {
        deps = true;
        G.starting = "正在安装系统依赖（首次使用）…";
        await runCli(["install-deps", "chromium"], true);
        continue;
      }
      throw e;
    }
  }
  throw new Error("无法启动浏览器内核");
}

function getCtx() {
  if (!G.ctx) {
    G.ctx = launch().catch((e) => {
      G.ctx = undefined;
      throw e;
    });
  }
  return G.ctx;
}

export function startingNote() {
  return G.ctx ? G.starting : undefined;
}

/* ---------------- 会话 / 标签页 ---------------- */

function wake(set: Set<() => void>) {
  for (const f of [...set]) f();
}

function bump(s: Session) {
  s.metaV++;
  wake(s.metaWaiters);
}

function notice(s: Session, kind: "info" | "error", text: string) {
  s.events.push({ id: ++s.evSeq, kind, text });
  if (s.events.length > 30) s.events.shift();
  bump(s);
}

function pushFrame(s: Session, buf: Buffer, y?: number) {
  s.frame = buf;
  if (typeof y === "number" && Number.isFinite(y)) s.frameY = y;
  s.lastFrameAt = Date.now();
  s.seq++;
  wake(s.frameWaiters);
}

export function touch(s: Session) {
  s.lastSeen = Date.now();
  G.lastActive = s;
}

export function getSession(id: string) {
  const s = G.sessions.get(id);
  return s && !s.closed ? s : undefined;
}

function activeTab(s: Session) {
  return s.tabs.find((t) => t.id === s.active);
}

async function refreshNav(tab: Tab) {
  try {
    const h = (await tab.cdp?.send("Page.getNavigationHistory")) as
      | { currentIndex: number; entries: unknown[] }
      | undefined;
    if (h) {
      tab.back = h.currentIndex > 0;
      tab.fwd = h.currentIndex < h.entries.length - 1;
    }
  } catch {
    /* ignore */
  }
}

async function applyUserAgent(page: Page, cdp: CDPSession) {
  try {
    const raw = await page.evaluate(() => navigator.userAgent);
    const m = /Chrome\/([\d.]+)/.exec(raw);
    if (!m) return;
    const full = m[1];
    const major = full.split(".")[0];
    const brands = [
      { brand: "Chromium", version: major },
      { brand: "Google Chrome", version: major },
      { brand: "Not_A Brand", version: "24" },
    ];
    await cdp.send("Emulation.setUserAgentOverride", {
      userAgent: `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`,
      acceptLanguage: "zh-CN,zh;q=0.9,en;q=0.8",
      platform: "Linux x86_64",
      userAgentMetadata: {
        brands,
        fullVersionList: brands.map((b) => ({ ...b, version: b.version === major ? full : "24.0.0.0" })),
        fullVersion: full,
        platform: "Linux",
        platformVersion: "6.1.0",
        architecture: "x86",
        model: "",
        mobile: false,
        bitness: "64",
        wow64: false,
      },
    });
  } catch {
    /* ignore */
  }
}

async function startCast(s: Session, tab: Tab) {
  if (!tab.cdp) return;
  try {
    await tab.cdp.send("Page.stopScreencast").catch(() => {});
    await tab.cdp.send("Page.startScreencast", {
      format: "jpeg",
      quality: CAST_QUALITY,
      maxWidth: s.w,
      maxHeight: s.h,
      everyNthFrame: 1,
    });
  } catch {
    /* ignore */
  }
  const before = s.seq;
  setTimeout(async () => {
    if (s.closed || s.seq !== before || s.castTab !== tab || tab.page.isClosed()) return;
    try {
      pushFrame(s, await tab.page.screenshot({ type: "jpeg", quality: CAST_QUALITY, timeout: 4000 }));
    } catch {
      /* ignore */
    }
  }, 500);
}

async function activateTab(s: Session, id: number) {
  const tab = s.tabs.find((t) => t.id === id);
  if (!tab) return;
  if (s.castTab && s.castTab !== tab) await s.castTab.cdp?.send("Page.stopScreencast").catch(() => {});
  s.active = id;
  s.castTab = tab;
  await tab.page.bringToFront().catch(() => {});
  await startCast(s, tab);
  bump(s);
}

async function adopt(s: Session, page: Page, activate: boolean): Promise<Tab> {
  const tab: Tab = {
    id: ++G.tabSeq,
    page,
    cdp: null,
    title: "",
    url: page.url() || "about:blank",
    loading: false,
    back: false,
    fwd: false,
  };
  s.tabs.push(tab);
  await page.setViewportSize({ width: s.w, height: s.h }).catch(() => {});
  try {
    const cdp = await page.context().newCDPSession(page);
    tab.cdp = cdp;
    cdp.on("Page.screencastFrame", (p) => {
      cdp.send("Page.screencastFrameAck", { sessionId: p.sessionId }).catch(() => {});
      if (s.castTab === tab && !s.closed) pushFrame(s, Buffer.from(p.data, "base64"), p.metadata?.scrollOffsetY);
    });
    await applyUserAgent(page, cdp);
  } catch {
    /* ignore */
  }

  const isMain = (r: { isNavigationRequest(): boolean; frame(): unknown }) => {
    try {
      return r.isNavigationRequest() && r.frame() === page.mainFrame();
    } catch {
      return false;
    }
  };
  page.on("framenavigated", (f) => {
    if (f === page.mainFrame()) {
      tab.url = f.url();
      bump(s);
      void refreshNav(tab).then(() => bump(s));
    }
  });
  page.on("domcontentloaded", () => {
    tab.loading = false;
    bump(s);
  });
  page.on("load", () => {
    tab.loading = false;
    bump(s);
  });
  page.on("request", (r) => {
    if (isMain(r)) {
      tab.loading = true;
      bump(s);
    }
  });
  page.on("requestfailed", (r) => {
    if (isMain(r)) {
      tab.loading = false;
      bump(s);
    }
  });
  page.on("close", () => void removeTab(s, tab.id));
  page.on("dialog", (d) => {
    notice(s, "info", `网页提示：${d.message().slice(0, 120)}`);
    d.accept().catch(() => {});
  });
  page.on("download", async (dl) => {
    try {
      await ensureHome();
      const name = (dl.suggestedFilename() || "download").replace(/[\\/\0]/g, "_");
      const ext = path.extname(name);
      const base = path.basename(name, ext);
      let dest = path.join(DOWNLOADS, name);
      for (let i = 1; (await exists(dest)) && i < 1000; i++) dest = path.join(DOWNLOADS, `${base} (${i})${ext}`);
      await dl.saveAs(dest);
      notice(s, "info", `已下载到 ${dest}`);
    } catch {
      notice(s, "error", "下载失败");
    }
  });

  if (activate) await activateTab(s, tab.id);
  bump(s);
  return tab;
}

async function removeTab(s: Session, id: number) {
  const i = s.tabs.findIndex((t) => t.id === id);
  if (i < 0) return;
  const [tab] = s.tabs.splice(i, 1);
  if (s.castTab === tab) s.castTab = null;
  if (s.closed) return;
  if (s.tabs.length === 0) {
    await newTab(s).catch(() => {});
  } else if (s.active === id) {
    await activateTab(s, s.tabs[Math.min(i, s.tabs.length - 1)].id);
  }
  bump(s);
}

async function newPage() {
  const ctx = await getCtx();
  G.creating++;
  try {
    if (G.spare && !G.spare.isClosed()) {
      const p = G.spare;
      G.spare = undefined;
      return p;
    }
    return await ctx.newPage();
  } finally {
    G.creating--;
  }
}

async function newTab(s: Session, url?: string) {
  const tab = await adopt(s, await newPage(), true);
  if (url) navigate(s, url);
  return tab;
}

async function onPopup(page: Page) {
  if (G.creating > 0) return;
  let owner: Session | undefined;
  try {
    const op = await page.opener();
    if (op) owner = [...G.sessions.values()].find((x) => x.tabs.some((t) => t.page === op));
  } catch {
    /* ignore */
  }
  owner ??= G.lastActive && !G.lastActive.closed ? G.lastActive : undefined;
  if (!owner || [...G.sessions.values()].some((x) => x.tabs.some((t) => t.page === page))) {
    if (!owner) await page.close().catch(() => {});
    return;
  }
  await adopt(owner, page, true);
}

function navigate(s: Session, raw: string) {
  const tab = activeTab(s);
  if (!tab) return;
  let url = raw.trim();
  if (url !== "about:blank") {
    try {
      const u = new URL(url);
      if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("protocol");
      url = u.href;
    } catch {
      return notice(s, "error", "只支持 http / https 网址");
    }
  }
  tab.loading = true;
  bump(s);
  tab.page.goto(url, { waitUntil: "commit", timeout: 30_000 }).catch((e: Error) => {
    tab.loading = false;
    bump(s);
    if (!/interrupted by another navigation|frame was detached|aborted/i.test(e.message)) {
      const m = /net::(ERR_[A-Z_]+)/.exec(e.message);
      if (m) notice(s, "error", `无法打开页面：${m[1]}`);
    }
  });
}

export async function createSession(w: number, h: number, url?: string) {
  if (G.sessions.size >= MAX_SESSIONS) throw new Error("浏览器窗口过多，请先关闭一个");
  await getCtx();
  ensureTimer();
  const s: Session = {
    id: Math.random().toString(36).slice(2) + Date.now().toString(36),
    tabs: [],
    active: 0,
    castTab: null,
    w: clamp(w, 200, 3000),
    h: clamp(h, 150, 3000),
    frame: null,
    seq: 0,
    frameWaiters: new Set(),
    metaV: 1,
    metaWaiters: new Set(),
    events: [],
    evSeq: 0,
    lastSeen: Date.now(),
    closed: false,
    chain: Promise.resolve(),
    buttons: 0,
    frameY: 0,
    lastFrameAt: 0,
  };
  G.sessions.set(s.id, s);
  G.lastActive = s;
  try {
    await adopt(s, await newPage(), true);
    if (url) navigate(s, url);
  } catch (e) {
    await closeSession(s);
    throw e;
  }
  return s;
}

function dropSession(s: Session) {
  s.closed = true;
  G.sessions.delete(s.id);
  if (G.lastActive === s) G.lastActive = undefined;
  wake(s.frameWaiters);
  wake(s.metaWaiters);
}

export async function closeSession(s: Session) {
  const tabs = [...s.tabs];
  dropSession(s);
  await Promise.all(
    tabs.map(async (t) => {
      await t.cdp?.send("Page.stopScreencast").catch(() => {});
      await t.page.close({ runBeforeUnload: false }).catch(() => {});
    }),
  );
}

function ensureTimer() {
  if (G.timer) return;
  G.timer = setInterval(async () => {
    const now = Date.now();
    for (const s of [...G.sessions.values()]) {
      if (now - s.lastSeen > IDLE_MS) {
        void closeSession(s);
        continue;
      }
      for (const t of s.tabs) {
        try {
          const title = await Promise.race([t.page.title(), sleep(700).then(() => t.title)]);
          if (title !== t.title) {
            t.title = title;
            bump(s);
          }
        } catch {
          /* ignore */
        }
      }
    }
  }, 1000);
  G.timer.unref?.();
}

/* ---------------- 长轮询：画面与元数据 ---------------- */

function waitOn(set: Set<() => void>, ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      set.delete(done);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    set.add(done);
    signal?.addEventListener("abort", done);
  });
}

export async function waitFrame(s: Session, seq: number, signal?: AbortSignal, ms = 8000) {
  if (!(s.frame && s.seq !== seq)) await waitOn(s.frameWaiters, ms, signal);
  if (s.frame && s.seq !== seq) return { seq: s.seq, buf: s.frame, y: s.frameY };
  return null;
}

export async function waitMeta(s: Session, v: number, signal?: AbortSignal) {
  if (s.metaV === v) await waitOn(s.metaWaiters, 15000, signal);
  return snapshot(s);
}

function snapshot(s: Session) {
  return {
    v: s.metaV,
    active: s.active,
    tabs: s.tabs.map((t) => ({
      id: t.id,
      title: t.title,
      url: t.url,
      loading: t.loading,
      back: t.back,
      fwd: t.fwd,
    })),
    events: s.events.slice(-10),
    note: G.starting ?? null,
  };
}

/* ---------------- 输入转发 ---------------- */

type Ev = Record<string, unknown>;
const KEY_RE = /^(?:(?:Control|Shift|Alt|Meta)\+)*(?:[^\s+]|\+|Space|[A-Za-z][A-Za-z0-9]{1,14})$/;

async function pressKey(page: Page, key: string) {
  if (key === " ") key = "Space";
  if (key.length === 1 && key.charCodeAt(0) > 127) {
    await page.keyboard.insertText(key);
    return;
  }
  if (!KEY_RE.test(key)) return;
  try {
    await page.keyboard.press(key);
  } catch {
    if (key.length === 1) await page.keyboard.insertText(key).catch(() => {});
  }
}

const btn = (b: unknown) => (b === 2 ? "right" : b === 1 ? "middle" : "left") as "left" | "right" | "middle";

const BIT = { left: 1, right: 2, middle: 4 } as const;

function mouse(
  s: Session,
  tab: Tab,
  type: "mouseMoved" | "mousePressed" | "mouseReleased" | "mouseWheel",
  x: number,
  y: number,
  button: "left" | "right" | "middle" | "none" = "none",
  clickCount = 0,
  dx = 0,
  dy = 0,
) {
  const p: Record<string, unknown> = {
    type,
    x,
    y,
    button: type === "mouseMoved" ? (s.buttons ? (s.buttons & 1 ? "left" : s.buttons & 4 ? "middle" : "right") : "none") : button,
    buttons: s.buttons,
    clickCount,
    pointerType: "mouse",
  };
  if (type === "mouseWheel") {
    p.deltaX = clamp(dx, -5000, 5000) || 0;
    p.deltaY = clamp(dy, -5000, 5000) || 0;
  }
  if (tab.cdp) {
    tab.cdp.send("Input.dispatchMouseEvent", p as never).catch(() => {});
  }
}

const FAST = new Set(["move", "down", "up", "wheel"]);

async function one(s: Session, ev: Ev, out: { selection?: string }) {
  const type = String(ev.type);
  // 不依赖当前标签页的操作
  switch (type) {
    case "newtab":
      await newTab(s, typeof ev.url === "string" ? ev.url : undefined);
      return;
    case "closetab": {
      const t = s.tabs.find((x) => x.id === Number(ev.id));
      if (t) await t.page.close({ runBeforeUnload: false }).catch(() => {});
      return;
    }
    case "switch":
      await activateTab(s, Number(ev.id));
      return;
    case "resize": {
      s.w = clamp(ev.w, 200, 3000);
      s.h = clamp(ev.h, 150, 3000);
      await Promise.all(s.tabs.map((t) => t.page.setViewportSize({ width: s.w, height: s.h }).catch(() => {})));
      const t = activeTab(s);
      if (t) await startCast(s, t);
      return;
    }
  }

  const tab = activeTab(s);
  if (!tab || tab.page.isClosed()) return;
  const page = tab.page;
  const x = clamp(ev.x, 0, 4000);
  const y = clamp(ev.y, 0, 4000);

  switch (type) {
    case "move":
      mouse(s, tab, "mouseMoved", x, y);
      break;
    case "down": {
      const b = btn(ev.button);
      mouse(s, tab, "mouseMoved", x, y);
      s.buttons |= BIT[b];
      mouse(s, tab, "mousePressed", x, y, b, clamp(ev.clickCount, 1, 3));
      break;
    }
    case "up": {
      const b = btn(ev.button);
      mouse(s, tab, "mouseReleased", x, y, b, clamp(ev.clickCount, 1, 3));
      s.buttons &= ~BIT[b];
      break;
    }
    case "wheel":
      mouse(s, tab, "mouseWheel", x, y, "none", 0, Number(ev.dx) || 0, Number(ev.dy) || 0);
      break;
    case "press":
      if (typeof ev.key === "string" && ev.key.length <= 40) await pressKey(page, ev.key);
      break;
    case "text":
      if (typeof ev.text === "string") await page.keyboard.insertText(ev.text.slice(0, 5000));
      break;
    case "goto":
      if (typeof ev.url === "string") navigate(s, ev.url);
      break;
    case "back":
      tab.page.goBack({ waitUntil: "commit", timeout: 15000 }).catch(() => {});
      break;
    case "forward":
      tab.page.goForward({ waitUntil: "commit", timeout: 15000 }).catch(() => {});
      break;
    case "reload":
      tab.loading = true;
      bump(s);
      tab.page.reload({ waitUntil: "commit", timeout: 30000 }).catch(() => {
        tab.loading = false;
        bump(s);
      });
      break;
    case "stop":
      await page.evaluate(() => window.stop()).catch(() => {});
      tab.loading = false;
      bump(s);
      break;
    case "selection":
      out.selection = await page.evaluate(() => String(window.getSelection() ?? "")).catch(() => "");
      break;
  }
}

export async function handleInput(s: Session, events: Ev[]) {
  const out: { selection?: string } = {};
  const slow: Ev[] = [];
  for (const ev of events.slice(0, 80)) {
    if (FAST.has(String(ev.type))) {
      try {
        await one(s, ev, out); // 内部不 await CDP，几乎同步
      } catch {
        /* ignore */
      }
    } else slow.push(ev);
  }
  if (!slow.length) return out;
  const run = async () => {
    for (const ev of slow) {
      try {
        await one(s, ev, out);
      } catch {
        /* 单个事件失败不影响后续 */
      }
    }
  };
  s.chain = s.chain.catch(() => {}).then(run);
  await s.chain;
  return out;
}
