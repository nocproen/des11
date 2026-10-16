"use client";

import { useEffect, useRef, useState } from "react";
import { useDialogs } from "../dialogs";
import { SYS_DRAG_KEY, baseName, readStoredSysClip, useSys } from "../sys-store";
import { useWm, type Win } from "../wm-store";
import { withDesktopAccess } from "../client-session";

type Status = {
  state: "preparing" | "starting" | "running" | "exited" | "failed";
  note: string;
  log: string;
  exitCode: number | null;
  name: string;
  rtt?: number; // 服务器实测的往返延迟（ms）
  stalls?: number; // 发送积压次数，带宽不足的直接信号
};

// noVNC（网页端 VNC 客户端）的最小接口
type Rfb = {
  disconnect(): void;
  focus(): void;
  addEventListener(type: string, cb: (e: CustomEvent) => void): void;
  clipboardPasteFrom(text: string): void;
  sendKey(keysym: number, code: string | null, down?: boolean): void;
  scaleViewport: boolean;
  resizeSession: boolean;
  showDotCursor: boolean;
  qualityLevel: number;
  compressionLevel: number;
  background: string;
};
type RfbCtor = new (target: HTMLElement, url: string, opts?: object) => Rfb;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 画质档位（0–9，数字越大越清晰、数据越多）。滚动 / 翻页时降到低档保证跟手，停下后自动恢复，
// 服务器会在空闲时把降质的区域补成清晰画面。
const Q_LOW = 1;
const Q_IDLE_MS = 500;

// 按实测链路质量选「静止时的目标画质 / 压缩级别」。
// 原来固定 quality=7 / compression=2：在延迟高或带宽窄的链路上，一次整屏更新几百 KB，
// 传输时间远超一帧的间隔，画面持续排队 —— 表现就是又糊又卡还一顿一顿地刷。
// 链路越差就主动把码率降下来，宁可稍微糊一点也要跟手；链路好时自动回到高画质。
type Tier = { q: number; c: number; label: string };
const TIERS: Tier[] = [
  { q: 8, c: 1, label: "极佳" }, // 本机 / 局域网：几乎不压缩，CPU 换清晰度
  { q: 7, c: 2, label: "良好" },
  { q: 5, c: 4, label: "一般" },
  { q: 3, c: 6, label: "较差" },
  { q: 2, c: 9, label: "很差" }, // 高延迟 / 窄带：最大压缩，优先保证响应
];


/** 根据 RTT 和积压次数挑一个画质档位 */
function pickTier(rtt: number, stalls: number): Tier {
  let i = rtt <= 0 ? 1 : rtt < 30 ? 0 : rtt < 90 ? 1 : rtt < 200 ? 2 : rtt < 400 ? 3 : 4;
  // 出现过发送积压 = 带宽不够（跟延迟无关），每累计几次就再降一档
  if (stalls > 0) i = Math.min(TIERS.length - 1, i + Math.min(2, Math.ceil(stalls / 3)));
  return TIERS[i];
}

// 服务器明确告知"这个会话已经不存在了"（附带原因）
type Gone = { gone: true; reason: string };

// 会话为什么没了 -> 给用户看的原因
const GONE_TEXT: Record<string, string> = {
  client: "窗口被关闭、页面被刷新，或点了“重新启动”",
  idle: "断开连接太久，应用已被回收",
  "auth-expired": "登录已过期，请刷新页面重新登录",
  replaced: "被同一个应用的新窗口替换了",
};
const goneMessage = (reason: string) => `会话已结束（${GONE_TEXT[reason] ?? "服务已重启，或会话已过期"}）`;

// noVNC 以原生 ES 模块方式从 /novnc 加载（它使用了顶层 await，不适合被打包）
async function loadRfb(): Promise<RfbCtor> {
  const url = "/novnc/core/rfb.js";
  const mod = await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ url);
  return mod.default as RfbCtor;
}

// 注意：只有服务器自己返回的 404（带 gone:true）才表示会话没了。本机被平台冻结 / 恢复期间，网关、代理也可能返回 404 / 5xx / 超时，
// 那些都只是"暂时连不上"（"error"），不能当成会话结束，否则还活着的应用会被误判，再点"重新启动"就被杀掉了。
async function getStatus(sid: string): Promise<Status | Gone | "error"> {
  try {
    const r = await fetch(`/api/gui/${sid}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
      headers: { "x-wd-build": process.env.NEXT_PUBLIC_WD_BUILD ?? "" },
    });
    if (r.status === 404) {
      const d = (await r.json().catch(() => null)) as { gone?: boolean; reason?: string } | null;
      return d?.gone ? { gone: true, reason: d.reason ?? "unknown" } : "error";
    }
    if (!r.ok) return "error";
    return (await r.json()) as Status;
  } catch {
    return "error";
  }
}

// 画布自检。浏览器可能在标签页放后台 / GPU 重置 / 电脑休眠唤醒后把画布内容丢掉，可见画布变成全透明（只剩网页背景色），
// 而 noVNC 只在画面"有变化"时才重画：画面静止就一直是空白，直到拖动窗口迫使它整屏重画。这里主动检测并修复。
type RfbInternals = {
  _display?: { _damage(x: number, y: number, w: number, h: number): void; flip(): void; _renderQ?: unknown[] };
  _sock?: unknown;
  _fbWidth?: number;
  _fbHeight?: number;
};
type RfbMessages = { fbUpdateRequest(sock: unknown, incremental: boolean, x: number, y: number, w: number, h: number): void };

let scratchCtx: CanvasRenderingContext2D | null | undefined;
function getScratch(): CanvasRenderingContext2D | null {
  if (scratchCtx !== undefined) return scratchCtx;
  scratchCtx = null;
  try {
    const c = document.createElement("canvas");
    c.width = c.height = 8;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    // 自检：能读回刚画的不透明像素才说明"读取画布"可用（有的浏览器 / 隐私插件会返回空白数据，那样就不能据此判断）
    ctx.fillStyle = "#123456";
    ctx.fillRect(0, 0, 8, 8);
    if (ctx.getImageData(0, 0, 1, 1).data[3] !== 255) return null;
    ctx.clearRect(0, 0, 8, 8);
    scratchCtx = ctx;
  } catch {
    scratchCtx = null;
  }
  return scratchCtx;
}

/** 可见画布是否完全没画过（全透明）。读不出来 / 不适用时返回 false，绝不误判。 */
function canvasBlank(host: HTMLElement): boolean {
  const c = host.querySelector("canvas");
  if (!c || !host.offsetParent) return false;
  return isBlank(c);
}

/** 画布是否全透明（画布不在页面上也能读）。读不出来时返回 false。 */
function isBlank(c: HTMLCanvasElement): boolean {
  const ctx = getScratch();
  if (!ctx || c.width === 0 || c.height === 0) return false;
  try {
    ctx.clearRect(0, 0, 8, 8);
    ctx.drawImage(c, 0, 0, c.width, c.height, 0, 0, 8, 8);
    const d = ctx.getImageData(0, 0, 8, 8).data;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) return false;
    return true;
  } catch {
    return false;
  }
}

/** 让 noVNC 整屏重画：先用后台缓冲区本地重绘（立即），再向服务器要一次完整画面（防止缓冲区本身也丢了）。 */
function repaint(r: Rfb, ctor: RfbCtor | null) {
  const x = r as unknown as RfbInternals;
  const w = x._fbWidth;
  const h = x._fbHeight;
  if (!w || !h) return;
  try {
    x._display?._damage(0, 0, w, h);
    x._display?.flip();
  } catch {
    /* 内部接口变了就算了 */
  }
  try {
    const m = (ctor as unknown as { messages?: RfbMessages } | null)?.messages;
    if (m && x._sock) m.fbUpdateRequest(x._sock, false, 0, 0, w, h);
  } catch {
    /* ignore */
  }
}

// 切换远程输入法（远程 fcitx5 的触发键是 Ctrl+Space）。由网页直接把按键发给远程，不经过本机键盘：
// Ctrl+Space 在 Windows 上是中文输入法的"中英文切换"系统热键，通常会被本机输入法截走，根本到不了网页。
// held：本机此刻是否已经按住了 Ctrl / Shift（noVNC 已经把这些修饰键转发给远程了，不能重复按，也要避开 Shift）。
function toggleRemoteIme(r: Rfb, held: { ctrl: boolean; shift: boolean }) {
  if (held.shift) r.sendKey(0xffe1, "ShiftLeft", false); // 先让远程认为 Shift 已松开，否则会变成 Ctrl+Shift+Space
  if (!held.ctrl) r.sendKey(0xffe3, "ControlLeft", true);
  r.sendKey(0x20, "Space", true);
  r.sendKey(0x20, "Space", false);
  if (!held.ctrl) r.sendKey(0xffe3, "ControlLeft", false);
  if (held.shift) r.sendKey(0xffe1, "ShiftLeft", true); // 本机 Shift 还按着，等用户松开时 noVNC 会照常发送抬起
}

// 把一段文字作为键盘输入发送给远程程序（Unicode 键值，中文也可以）
function typeText(r: Rfb, text: string) {
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp === 10 || cp === 13) r.sendKey(0xff0d, null);
    else if (cp === 9) r.sendKey(0xff09, null);
    else r.sendKey(cp < 0x100 ? cp : 0x01000000 + cp, null);
  }
}

export function GuiApp({ win }: { win: Win }) {
  const wm = useWm();
  const wmRef = useRef(wm);
  wmRef.current = wm;

  const hostRef = useRef<HTMLDivElement>(null);
  const ghostRef = useRef<HTMLDivElement>(null); // 断线期间留在屏幕上的最后一帧
  const rfbRef = useRef<Rfb | null>(null);
  const sidRef = useRef<string | null>(null);
  const [phase, setPhase] = useState<"preparing" | "running" | "ended">("preparing");
  const [status, setStatus] = useState<Status | null>(null);
  const [err, setErr] = useState("");
  const [runKey, setRunKey] = useState(0);
  const [reconnecting, setReconnecting] = useState(false);
  const [frozen, setFrozen] = useState(false); // 正在显示断线前的最后一帧
  const [net, setNet] = useState<{ rtt: number; label: string } | null>(null); // 实测链路质量（用于显示）
  const netRef = useRef(0); // 同一个 RTT 的 ref 版本：effect 闭包里读 state 会永远是旧值
  const [ime, setIme] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const dlg = useDialogs();
  const { clip: sysClipState } = useSys();
  const [imeText, setImeText] = useState("");
  const imeRef = useRef<HTMLInputElement>(null);
  // VNC 会话内部复制的文本：只缓存，不自动覆盖本机剪贴板（否则会冲掉用户本地复制的内容）
  const [vncClip, setVncClip] = useState("");
  const vncClipRef = useRef("");
  const focused = wm.focusedId === win.id;
  const winId = win.id;
  const isBrowser = win.app === "browser";
  const { cmd, desktopFile } = win;

  // 这些值只在启动时读取，变化不应让会话重启
  const initial = useRef({ title: win.title, path: win.path });
  initial.current = { title: win.title, path: win.path };

  useEffect(() => {
    if (focused && !ime) rfbRef.current?.focus();
  }, [focused, ime]);

  const appName = status?.name;
  useEffect(() => {
    if (appName && !initial.current.title) wmRef.current.patch(winId, { title: appName });
  }, [appName, winId]);

  // 已经在运行的浏览器收到新网址（比如终端里 open https://…）：交给它在新标签页打开
  const pendingUrl = win.pendingUrl;
  useEffect(() => {
    if (!pendingUrl || phase !== "running" || !sidRef.current) return;
    void fetch(`/api/gui/${sidRef.current}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: pendingUrl }),
    })
      .catch(() => {})
      .finally(() => wmRef.current.patch(winId, { pendingUrl: undefined }));
  }, [pendingUrl, phase, winId]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let dead = false;
    let sid: string | null = null;
    let rfb: Rfb | null = null;
    let everConnected = false;
    let failedConnects = 0; // 连续没连上的次数（成功连上就清零），用来放慢重试节奏、显示提示
    let rfbCtor: RfbCtor | null = null;
    let connectedAt = 0;
    let wdTimer: ReturnType<typeof setInterval> | undefined;
    let blankSince = 0; // 可见画布最早被发现空白的时间
    let lastHead: unknown = null; // noVNC 渲染队列队首（长时间不变 = 卡住了）
    let lastSig = ""; // 队列「指纹」：长度也算进去，用来区分「真卡死」和「只是在慢慢收」
    let headSince = 0;
    let forcedReconnects: number[] = []; // 最近因"画布空白 / 渲染卡住"而强制重连的时间，防止无限循环
    let qTimer: ReturnType<typeof setTimeout> | undefined;
    // 调试 / 对比用：localStorage.wdQ = 固定画质（关闭动态降质）
    const fq = Number(localStorage.getItem("wdQ"));
    const forcedQ = localStorage.getItem("wdQ") !== null && Number.isInteger(fq) && fq >= 0 && fq <= 9 ? fq : null;

    let wakeNap: (() => void) | null = null;
    const nap = (ms: number) =>
      new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(t);
          if (wakeNap === done) wakeNap = null;
          resolve();
        };
        const t = setTimeout(done, ms);
        wakeNap = done;
      });
    const onOnline = () => wakeNap?.();
    const onVisible = () => !document.hidden && wakeNap?.();
    window.addEventListener("online", onOnline);
    window.addEventListener("focus", onOnline);
    document.addEventListener("visibilitychange", onVisible);

    const setQuality = (r: Rfb, q: number) => {
      if (r.qualityLevel !== q) r.qualityLevel = q;
      host.dataset.quality = String(q);
    };

    // 当前链路档位（由下面的探测器按实测 RTT 更新）
    let tier = TIERS[1];
    const applyTier = (r: Rfb, t: Tier) => {
      tier = t;
      if (r.compressionLevel !== t.c) r.compressionLevel = t.c;
      if (forcedQ === null) setQuality(r, t.q);
    };

    // 链路探测：每 5 秒读一次服务器实测的 RTT / 积压次数，自动升降画质。
    // 顺带还是一次轻量的存活检查：会话真的没了会被这里发现，而不用干等 WebSocket 超时。
    let netTimer: ReturnType<typeof setInterval> | undefined;
    const probe = async () => {
      const r = rfb;
      if (dead || !r || rfbRef.current !== r || document.hidden || !sid) return;
      const st = await getStatus(sid);
      if (dead || rfb !== r || typeof st !== "object" || "gone" in st) return;
      netRef.current = st.rtt ?? 0;
      setNet({ rtt: st.rtt ?? 0, label: pickTier(st.rtt ?? 0, st.stalls ?? 0).label });
      const t = pickTier(st.rtt ?? 0, st.stalls ?? 0);
      if (t !== tier) applyTier(r, t);
    };
    const startProbe = () => {
      clearInterval(netTimer);
      netTimer = setInterval(() => void probe(), 5000);
      void probe();
    };

    // 断线时 noVNC 会把画面整个从页面上拿掉，重连 + 传完第一屏之前窗口只剩一片黑。
    // 这里把拿掉的那块画面（画布内容还在）挂到上层继续显示，等新连接画出第一屏再撤掉。
    let releaseTimer: ReturnType<typeof setInterval> | undefined;
    const keepFrame = (screen: HTMLElement | null) => {
      const ghost = ghostRef.current;
      const c = screen?.querySelector("canvas");
      if (!ghost || !screen || !c || isBlank(c)) return;
      clearInterval(releaseTimer);
      ghost.replaceChildren(screen);
      setFrozen(true);
    };
    const dropFrame = () => {
      clearInterval(releaseTimer);
      ghostRef.current?.replaceChildren();
      setFrozen(false);
    };
    const releaseFrameWhenPainted = () => {
      if (!ghostRef.current?.firstChild) return;
      clearInterval(releaseTimer);
      const since = Date.now();
      releaseTimer = setInterval(() => {
        if (dead || !canvasBlank(host) || Date.now() - since > 8000) dropFrame();
      }, 100);
    };

    const end = (message: string, st?: Status) => {
      if (dead) return;
      dropFrame();
      if (st) setStatus(st);
      setErr(message);
      setReconnecting(false);
      setPhase("ended");
    };

    const connect = async () => {
      let RFB: RfbCtor;
      try {
        RFB = await loadRfb();
      } catch {
        return end("无法加载远程桌面组件");
      }
      if (dead) return;
      rfbCtor = RFB;
      host.innerHTML = "";
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const r = new RFB(host, withDesktopAccess(`${proto}://${location.host}/api/gui/ws?sid=${sid}`), { shared: true });
      const screen = host.firstElementChild as HTMLElement | null; // noVNC 的画面容器（里面是画布）
      rfb = r;
      rfbRef.current = r;
      r.scaleViewport = false;
      r.resizeSession = true; // 窗口大小变化时，让虚拟显示器跟着变
      r.showDotCursor = false;
      r.background = "#0b1120";
      // 沿用上一次探测到的链路档位：重连后不要又从高画质重新试探一遍，
      // 否则每次重连都会先灌一屏大图，让本来就差的链路雪上加霜。
      r.compressionLevel = tier.c;
      setQuality(r, forcedQ ?? tier.q);
      // 12 秒还没连上（比如网关把请求挂住了）：放弃这次连接，走重连流程。noVNC 自己没有连接超时，会一直是空白
      let connected = false;
      const connTimer = setTimeout(() => {
        if (!connected && rfb === r) r.disconnect();
      }, 12_000);
      r.addEventListener("connect", () => {
        connected = true;
        clearTimeout(connTimer);
        everConnected = true;
        failedConnects = 0;
        connectedAt = Date.now();
        setReconnecting(false);
        setPhase("running");
        r.focus();
        startWatchdog(r);
        startProbe();
        releaseFrameWhenPainted();
      });
      // VNC 内部复制时不再自动写回本机剪贴板：那会冲掉用户本地复制的内容。
      // 改为缓存到 vncClip，用户点按钮或按 Ctrl+Shift+V 时才取用。
      r.addEventListener("clipboard", (e) => {
        const text = (e.detail as { text?: string } | undefined)?.text;
        if (text) {
          vncClipRef.current = text;
          setVncClip(text);
        }
      });
      r.addEventListener("disconnect", async () => {
        clearTimeout(connTimer);
        if (dead) return;
        if (rfbRef.current === r) rfbRef.current = null;
        if (connected) keepFrame(screen);
        setReconnecting(true); // 必须马上告诉用户在重连（画面已经冻住 / 变空白）
        // 刚才还连得好好的（网关定期掐断长连接、网络抖动）：会话几乎一定还在，直接重连，省掉一次状态查询的往返。
        // 只连上一下就断的不走这条路，免得服务器反复接受又断开时原地狂转。
        if (connected && Date.now() - connectedAt > 3000) {
          void connect();
          return;
        }
        // 断线不等于应用没了：网络抖动、电脑休眠、代理掐断空闲连接、整台服务器被平台冻结时，应用都还在服务器上。
        // 只有服务器明确说"会话不存在"才算结束；其余情况一直重试（失败间隔逐渐拉长到 15 秒（后台标签页 90 秒）；网络恢复 / 切回标签页 / 窗口获得焦点时立即重试）。
        let wait = 600;
        for (;;) {
          const st = sid ? await getStatus(sid) : ({ gone: true, reason: "unknown" } as Gone);
          if (dead) return;
          if (st !== "error" && "gone" in st) return end(goneMessage(st.reason));
          if (st !== "error") {
            if (st.state === "running") {
              if (failedConnects++ >= 2) {
                setReconnecting(true); // 连续几次都没连稳：显示提示，并放慢重试节奏
                await nap(Math.min(failedConnects * 500, 5000));
                if (dead) return;
              }
              void connect();
              return;
            }
            if (st.state === "exited" && st.exitCode === 0 && everConnected) {
              wmRef.current.close(winId); // 程序自己正常退出：像本地一样关闭窗口
              return;
            }
            return end(st.state === "failed" ? st.note || "启动失败" : "应用已退出", st);
          }
          // 暂时连不上服务器（网络断了 / 服务器被冻结或正在恢复）：继续等
          setReconnecting(true);
          await nap(wait);
          if (dead) return;
          wait = Math.min(wait * 1.6, document.hidden ? 90_000 : 15_000); // 没人看的后台标签页放慢；切回来会立即重试
        }
      });
    };

    // 看门狗：连上之后定期自检。空白就重绘；重绘后仍空白 / 渲染队列卡死，就强制重连（会话不受影响，只是换一张新画布）
    const forceReconnect = (r: Rfb, why: string) => {
      const now = Date.now();
      forcedReconnects = forcedReconnects.filter((t) => now - t < 120_000);
      if (forcedReconnects.length >= 3) return; // 2 分钟内已经重连过 3 次还不行，别再折腾了
      forcedReconnects.push(now);
      console.warn(`[gui] ${why}，重新连接`);
      r.disconnect();
    };
    const check = () => {
      const r = rfb;
      if (dead || !r || rfbRef.current !== r || document.hidden || !host.offsetParent) {
        blankSince = 0;
        lastHead = null;
        return;
      }
      // 所有判定阈值都要跟着实测延迟放宽。
      // 固定 3/5/4 秒的阈值在慢链路上是致命的：一屏画面本来就要传好几秒，
      // 看门狗却按「卡死」处理并强制重连，重连后又要重新传一屏，于是永远收敛不了 ——
      // 用户看到的就是「一直在闪、一直在重连」。链路越慢，越要给它时间，而不是越急着重连。
      const rtt = netRef.current;
      const slow = Math.max(1, Math.min(6, rtt / 80)); // 1x ~ 6x 的宽容倍数
      const GRACE = 3000 * slow; // 刚连上的首屏宽限
      const Q_STUCK = 8000 * slow; // 渲染队列判定卡死
      const BLANK_BAD = 8000 * slow; // 重绘后仍空白判定

      if (Date.now() - connectedAt < GRACE) return; // 刚连上，第一屏还在路上

      // 1) 渲染队列卡死：队首长时间没变（比如某块图片解码失败，noVNC 会永远等下去）
      const q = (r as unknown as RfbInternals)._display?._renderQ;
      if (q && q.length > 0) {
        // 关键修正：队首没变、但队列长度在变，说明数据还在源源不断地到，只是解码慢 —— 这不是卡死。
        const sig = `${String(q.length)}|${q[0] === lastHead ? "same" : "new"}`;
        if (q[0] !== lastHead || sig !== lastSig) {
          lastHead = q[0];
          lastSig = sig;
          headSince = Date.now();
        } else if (Date.now() - headSince > Q_STUCK) {
          lastHead = null;
          return forceReconnect(r, "渲染队列卡住");
        }
      } else {
        lastHead = null;
        lastSig = "";
      }

      // 2) 可见画布空白。先尝试本地重绘（无需网络、无感知），只有重绘也救不回来才重连。
      if (canvasBlank(host)) {
        if (!blankSince) {
          blankSince = Date.now();
          console.warn("[gui] 画布空白，重绘");
          repaint(r, rfbCtor);
        } else if (Date.now() - blankSince > BLANK_BAD) {
          blankSince = 0;
          forceReconnect(r, "重绘后画布仍然空白");
        }
      } else {
        blankSince = 0;
      }
    };
    const startWatchdog = (r: Rfb) => {
      clearInterval(wdTimer);
      blankSince = 0;
      lastHead = null;
      wdTimer = setInterval(check, 2000);
      void r;
    };
    // 切回标签页 / 窗口获得焦点 / 从后退缓存恢复：这些时候最容易丢画布，马上重绘一次并自检
    const refreshNow = () => {
      const r = rfb;
      if (dead || !r || rfbRef.current !== r || document.hidden) return;
      repaint(r, rfbCtor);
      setTimeout(check, 800);
    };
    const onShow = () => refreshNow();
    document.addEventListener("visibilitychange", onShow);
    window.addEventListener("focus", onShow);
    window.addEventListener("pageshow", onShow);

    // 滚动时临时降画质，停下后恢复
    const onWheel = () => {
      const r = rfb;
      if (!r || forcedQ !== null) return;
      setQuality(r, Q_LOW);
      clearTimeout(qTimer);
      // 滚动结束后回到「当前链路档位」而不是写死的高画质
      qTimer = setTimeout(() => rfb && setQuality(rfb, tier.q), Q_IDLE_MS);
    };
    host.addEventListener("wheel", onWheel, { capture: true, passive: true });

    // 本机剪贴板里的图片（如 QQ / 微信截图）：上传后放进远程剪贴板。没有图片时返回 false
    const pasteImage = async (): Promise<boolean> => {
      if (!navigator.clipboard?.read || !sid) return false;
      let blob: Blob | null = null;
      try {
        for (const item of await navigator.clipboard.read()) {
          const type = item.types.find((t) => t.startsWith("image/"));
          if (type) {
            blob = await item.getType(type);
            break;
          }
        }
      } catch {
        return false;
      }
      if (!blob) return false;
      const res = await fetch(`/api/gui/${sid}/clipboard`, {
        method: "POST",
        headers: { "Content-Type": blob.type },
        body: blob,
      }).catch(() => null);
      return !!res?.ok;
    };

    // 本机复制的文件通过浏览器 paste 事件粘贴进 VNC
    const onPaste = (ev: ClipboardEvent) => {
      if (!sid) return;
      const files = Array.from(ev.clipboardData?.files ?? []);
      if (!files.length) return;
      ev.preventDefault();
      ev.stopPropagation();
      const f = files[0];
      void fetch(`/api/gui/${sid}/clipboard?name=${encodeURIComponent(f.name)}&paste=1`, {
        method: "POST",
        headers: { "Content-Type": f.type || "application/octet-stream" },
        body: f,
      }).catch(() => {});
    };
    host.addEventListener("paste", onPaste, true);

    // Ctrl+Shift+Space：切换远程输入法（Ctrl+Space 本身常被本机 Windows 输入法占用）
    // Ctrl+V：优先把模拟桌面/文件管理器复制的文件或图片同步给远程 VNC 并触发粘贴，其次读取本机剪贴板图片或文字
    const onKey = (ev: KeyboardEvent) => {
      const r = rfb;
      if (ev.code === "ShiftLeft" || ev.code === "ShiftRight") {
        if (!ev.repeat) shiftTap = Date.now();
      } else {
        shiftTap = 0; // 中间按了别的键（比如 Shift+字母打大写）：不算单独按 Shift
      }
      if (r && ev.code === "Space" && ev.ctrlKey && ev.shiftKey && !ev.altKey && !ev.metaKey) {
        ev.preventDefault();
        ev.stopPropagation();
        if (!ev.repeat) toggleRemoteIme(r, { ctrl: true, shift: true });
        return;
      }
      // Ctrl+Shift+V：把 VNC 里复制的文本取回本机剪贴板（不自动覆盖本地剪贴板）
      if (r && ev.code === "KeyV" && (ev.ctrlKey || ev.metaKey) && ev.shiftKey && !ev.altKey) {
        ev.preventDefault();
        ev.stopPropagation();
        if (!ev.repeat) {
          const text = vncClipRef.current;
          if (text) {
            navigator.clipboard?.writeText(text).then(
              () => dlg.toast("已把 VNC 里复制的文本取回本机剪贴板"),
              () => dlg.toast("取回失败：浏览器拒绝了剪贴板写入权限"),
            );
          } else {
            dlg.toast("VNC 会话里还没有复制过文本");
          }
        }
        return;
      }
      if (!r || !(ev.ctrlKey || ev.metaKey) || ev.shiftKey || ev.altKey || ev.key.toLowerCase() !== "v") return;
      ev.preventDefault();
      ev.stopPropagation();
      const press = () => {
        r.sendKey(0xffe3, "ControlLeft", true);
        r.sendKey(0x76, "KeyV", true);
        r.sendKey(0x76, "KeyV", false);
        r.sendKey(0xffe3, "ControlLeft", false);
      };
      const storedClip = readStoredSysClip();
      if (sid && storedClip && storedClip.paths.length > 0) {
        void fetch(`/api/gui/${sid}/clipboard`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ paths: storedClip.paths, cut: storedClip.cut, triggerPaste: true }),
        }).catch(() => press());
        return;
      }
      void pasteImage().then((done) => {
        if (done) return setTimeout(press, 50);
        if (!navigator.clipboard?.readText) return press();
        navigator.clipboard.readText().then(
          (text) => {
            if (text) r.clipboardPasteFrom(text);
            setTimeout(press, 50);
          },
          press,
        );
      });
    };
    host.addEventListener("keydown", onKey, true);

    // 单独按一下 Shift（左右都行；中间没按别的键、没点鼠标）= 切换远程中/英输入法，和 Windows 输入法习惯一致。
    // Ctrl+Space 会被本机 Windows 吞掉；而 Claude 这类 Electron 程序不会把单独的 Shift 交给远程输入法，所以由网页来翻译。
    let shiftTap = 0;
    const onKeyUp = (ev: KeyboardEvent) => {
      if (ev.code !== "ShiftLeft" && ev.code !== "ShiftRight") return;
      const t = shiftTap;
      shiftTap = 0;
      const r = rfb;
      if (!r || !t || Date.now() - t > 600) return;
      setTimeout(() => toggleRemoteIme(r, { ctrl: false, shift: false }), 30); // 等 Shift 抬起先送到远程
    };
    const onPointer = () => (shiftTap = 0);
    host.addEventListener("keyup", onKeyUp, true);
    host.addEventListener("pointerdown", onPointer, true);

    // 关页不结束图形程序：重新登录后复用相同 VNC 会话和画面。
    let pageLeaving = false;
    const onHide = (ev: PageTransitionEvent) => {
      if (!ev.persisted) pageLeaving = true;
    };
    window.addEventListener("pagehide", onHide);

    (async () => {
      setPhase("preparing");
      setStatus(null);
      setErr("");
      const box = host.getBoundingClientRect();
      const init = initial.current;
      try {
        const res = await fetch("/api/gui", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            isBrowser
              ? { preset: "browser", url: init.path, sidHint: win.guiSid, w: Math.round(box.width) || 1024, h: Math.round(box.height) || 640 }
              : {
                  exec: cmd,
                  desktopFile,
                  sidHint: win.guiSid,
                  cwd: init.path,
                  name: init.title,
                  w: Math.round(box.width) || 1024,
                  h: Math.round(box.height) || 640,
                },
          ),
        });
        const d = (await res.json().catch(() => ({}))) as { sid?: string; error?: string };
        if (!res.ok || !d.sid) return end(d.error ?? "启动失败");
        sid = d.sid;
        sidRef.current = sid;
        wmRef.current.patch(winId, { guiSid: sid });
        if (dead) {
          if (!isBrowser) void fetch(`/api/gui/${sid}`, { method: "DELETE" });
          return;
        }
        for (;;) {
          const st = await getStatus(sid);
          if (dead) return;
          if (st !== "error" && "gone" in st) return end(goneMessage(st.reason));
          if (st !== "error") {
            setStatus(st);
            if (st.state === "running") break;
            if (st.state === "exited" || st.state === "failed") {
              return end(st.state === "failed" ? st.note || "启动失败" : "应用已退出", st);
            }
          }
          await sleep(700);
        }
        await connect();
      } catch {
        end("网络错误");
      }
    })();

    return () => {
      dead = true;
      clearTimeout(qTimer);
      host.removeEventListener("wheel", onWheel, true);
      host.removeEventListener("paste", onPaste, true);
      host.removeEventListener("keydown", onKey, true);
      host.removeEventListener("keyup", onKeyUp, true);
      host.removeEventListener("pointerdown", onPointer, true);
      window.removeEventListener("pagehide", onHide);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("focus", onOnline);
      document.removeEventListener("visibilitychange", onVisible);
      clearInterval(wdTimer);
      clearInterval(netTimer);
      document.removeEventListener("visibilitychange", onShow);
      window.removeEventListener("focus", onShow);
      window.removeEventListener("pageshow", onShow);
      rfb?.disconnect();
      rfbRef.current = null;
      sidRef.current = null;
      if (sid && !pageLeaving) void fetch(`/api/gui/${sid}`, { method: "DELETE", keepalive: true }).catch(() => {});
      host.innerHTML = "";
      dropFrame();
    };
  }, [runKey, winId, cmd, desktopFile, isBrowser]);

  // 从网页桌面 / 文件管理器或本地电脑拖进来的文件/图片：设置多目标剪贴板并在松手处点击粘贴
  const dropProps = {
    onDragOver: (e: React.DragEvent) => {
      const hasSys = e.dataTransfer.types.includes(SYS_DRAG_KEY);
      const hasLocal = e.dataTransfer.types.includes("Files");
      if (phase !== "running" || (!hasSys && !hasLocal)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = hasSys ? "move" : "copy";
      setDragOver(true);
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false);
    },
    onDrop: (e: React.DragEvent) => {
      setDragOver(false);
      const file = e.dataTransfer.getData(SYS_DRAG_KEY);
      const sid = sidRef.current;
      const canvas = hostRef.current?.querySelector("canvas");
      if (!sid || !canvas) return;
      const rect = canvas.getBoundingClientRect();
      const x = ((e.clientX - rect.left) * canvas.width) / Math.max(1, rect.width);
      const y = ((e.clientY - rect.top) * canvas.height) / Math.max(1, rect.height);
      if (file) {
        e.preventDefault();
        void fetch(`/api/gui/${sid}/drop`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: file, x, y }),
        })
          .then(async (r) => {
            if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? "拖入失败");
            dlg.toast(`已将「${baseName(file)}」粘贴到当前应用`);
            rfbRef.current?.focus();
          })
          .catch((err) => dlg.toast(`「${baseName(file)}」${err instanceof Error ? err.message : "拖入失败"}`));
        return;
      }
      const localFiles = Array.from(e.dataTransfer.files ?? []);
      if (localFiles.length > 0) {
        e.preventDefault();
        const lf = localFiles[0];
        void fetch(
          `/api/gui/${sid}/clipboard?name=${encodeURIComponent(lf.name)}&paste=1&x=${Math.round(x)}&y=${Math.round(y)}`,
          {
            method: "POST",
            headers: { "Content-Type": lf.type || "application/octet-stream" },
            body: lf,
          },
        )
          .then(async (r) => {
            if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? "拖入失败");
            dlg.toast(`已将「${lf.name}」粘贴到当前应用`);
            rfbRef.current?.focus();
          })
          .catch((err) => dlg.toast(`「${lf.name}」${err instanceof Error ? err.message : "拖入失败"}`));
      }
    },
  };

  const quickPasteToVnc = async () => {
    const sid = sidRef.current;
    const r = rfbRef.current;
    if (!sid || !r) return;
    const stored = sysClipState ?? readStoredSysClip();
    if (stored && stored.paths.length > 0) {
      const res = await fetch(`/api/gui/${sid}/clipboard`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paths: stored.paths, cut: stored.cut, triggerPaste: true }),
      }).catch(() => null);
      if (res?.ok) {
        dlg.toast(`已将「${baseName(stored.paths[0])}」粘贴到当前 VNC 应用`);
        r.focus();
        return;
      }
    }
    try {
      if (navigator.clipboard?.read) {
        for (const item of await navigator.clipboard.read()) {
          const type = item.types.find((t) => t.startsWith("image/"));
          if (type) {
            const blob = await item.getType(type);
            const res = await fetch(`/api/gui/${sid}/clipboard?paste=1`, {
              method: "POST",
              headers: { "Content-Type": blob.type },
              body: blob,
            }).catch(() => null);
            if (res?.ok) {
              dlg.toast("已将剪贴板图片粘贴到当前 VNC 应用");
              r.focus();
              return;
            }
          }
        }
      }
    } catch {
      /* ignore */
    }
    await fetch(`/api/gui/${sid}/clipboard`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ triggerPaste: true }),
    }).catch(() => {});
    r.focus();
    dlg.toast("已向当前 VNC 应用发送粘贴指令 (Ctrl+V)");
  };

  // 把 VNC 会话里复制的文本取回本机剪贴板（用户主动触发，不自动覆盖）
  const pullVncClip = async () => {
    const text = vncClipRef.current || vncClip;
    if (!text) {
      dlg.toast("VNC 会话里还没有复制过文本");
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      dlg.toast("已把 VNC 里复制的文本取回本机剪贴板");
    } catch {
      dlg.toast("取回失败：浏览器拒绝了剪贴板写入权限");
    }
  };

  const sendIme = () => {
    const r = rfbRef.current;
    if (!r || !imeText) return;
    typeText(r, imeText);
    setImeText("");
    imeRef.current?.focus();
  };

  return (
    <div className="relative flex h-full flex-col bg-[#0b1120]">
      <div className="relative min-h-0 flex-1" {...dropProps}>
        <div ref={hostRef} className="absolute inset-0" />
        <div ref={ghostRef} className="pointer-events-none absolute inset-0 z-10" hidden={!frozen} />
        {dragOver && (
          <div className="pointer-events-none absolute inset-0 z-30 grid place-items-end justify-center rounded border-2 border-dashed border-[var(--accent)] bg-[var(--accent)]/10 pb-6">
            <div className="rounded-full bg-black/70 px-4 py-1.5 text-sm text-white shadow-lg">松开鼠标，将文件或图片粘贴到当前应用</div>
          </div>
        )}

        {phase === "running" && (
          <button
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => void quickPasteToVnc()}
            title={
              sysClipState?.paths.length
                ? `粘贴已复制的「${baseName(sysClipState.paths[0])}」到当前 VNC 应用（或直接按 Ctrl+V）`
                : "将桌面已复制的文件/图片或本机剪贴板粘贴到当前 VNC 应用（Ctrl+V）"
            }
            className="absolute bottom-3 right-25 z-10 grid h-9 min-w-9 place-items-center rounded-full bg-black/50 px-2.5 text-xs font-medium text-slate-200 shadow-lg backdrop-blur hover:bg-black/70"
          >
            📋{sysClipState?.paths.length ? " 粘贴" : ""}
          </button>
        )}

        {phase === "running" && (
          <button
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => void pullVncClip()}
            title={
              vncClip
                ? "把 VNC 里复制的文本取回本机剪贴板（不再自动覆盖本地剪贴板）"
                : "VNC 会话里复制的文本会缓存在这里，点我取回本机剪贴板"
            }
            className="absolute bottom-3 right-36 z-10 grid h-9 min-w-9 place-items-center rounded-full bg-black/50 px-2 text-sm font-medium text-slate-200 shadow-lg backdrop-blur hover:bg-black/70"
          >
            ⤵
          </button>
        )}

        {phase === "running" && (
          <button
            onMouseDown={(e) => e.preventDefault()} // 不抢走画面里输入框的焦点
            onClick={() => {
              const r = rfbRef.current;
              if (!r) return;
              toggleRemoteIme(r, { ctrl: false, shift: false });
              r.focus();
            }}
            title="切换中/英输入法（也可以单独按一下 Shift，或按 Ctrl+Shift+Space）。先点一下输入框再切换"
            className="absolute bottom-3 right-14 z-10 grid h-9 min-w-9 place-items-center rounded-full bg-black/50 px-2 text-sm font-medium text-slate-200 shadow-lg backdrop-blur hover:bg-black/70"
          >
            拼
          </button>
        )}

        {phase === "running" && (
          <button
            onClick={() => {
              setIme((v) => !v);
              setTimeout(() => (ime ? rfbRef.current?.focus() : imeRef.current?.focus()), 50);
            }}
            title="中文输入：把文字发送到应用里的光标处"
            className={`absolute bottom-3 right-3 z-10 grid h-9 min-w-9 place-items-center rounded-full px-2 text-sm font-medium shadow-lg backdrop-blur ${
              ime ? "bg-[var(--accent)] text-white" : "bg-black/50 text-slate-200 hover:bg-black/70"
            }`}
          >
            中
          </button>
        )}

        <style>{"@keyframes wdfade{from{opacity:0}to{opacity:1}}"}</style>

        {/* 链路质量指示：延迟高时主动告诉用户「是网络慢，不是应用卡」，并说明画质已自动下调 */}
        {phase === "running" && !reconnecting && net && net.rtt > 0 && (
          <div
            className="pointer-events-none absolute bottom-2 right-2 z-20 flex items-center gap-1.5 rounded-full bg-black/55 px-2.5 py-1 text-[11px] text-slate-300 backdrop-blur"
            title={`往返延迟 ${net.rtt}ms · 画质已按链路自动调整为「${net.label}」档`}
          >
            <span
              className="inline-block h-1.5 w-1.5 rounded-full"
              style={{
                background:
                  net.rtt < 90 ? "#4ade80" : net.rtt < 200 ? "#facc15" : net.rtt < 400 ? "#fb923c" : "#f87171",
              }}
            />
            <span>{net.rtt}ms</span>
            {net.rtt >= 200 && <span className="text-slate-400">· 已降画质保流畅</span>}
          </div>
        )}

        {reconnecting && phase === "running" && frozen && (
          // 还能看到断线前的画面：只在顶部给个小提示，不挡内容。很快就连上的话（0.6 秒内）什么都不显示
          <div className="pointer-events-none absolute inset-0 z-20" style={{ animation: "wdfade .3s ease .6s both" }}>
            <div className="absolute inset-0 bg-black/15" />
            <div className="absolute left-1/2 top-3 flex -translate-x-1/2 items-center gap-2 rounded-full bg-black/70 px-3.5 py-1.5 text-xs text-slate-200 shadow-lg backdrop-blur">
              <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/20 border-t-[var(--accent)]" />
              <span>正在重新连接…应用仍在运行</span>
            </div>
          </div>
        )}
        {reconnecting && phase === "running" && !frozen && (
          <div
            className="pointer-events-none absolute inset-0 z-20 grid place-items-center"
            style={{ animation: "wdfade .3s ease .6s both" }}
          >
            <div className="rounded-xl bg-black/60 px-6 py-4 text-center text-slate-200 shadow-lg backdrop-blur">
              <div className="mx-auto mb-3 h-7 w-7 animate-spin rounded-full border-2 border-white/20 border-t-[var(--accent)]" />
              <div className="text-sm">连接中断，正在重新连接…</div>
              <div className="mt-1 text-xs text-slate-400">应用仍在服务器上运行，连上后会自动恢复</div>
            </div>
          </div>
        )}

        {phase === "preparing" && (
          <div className="absolute inset-0 grid place-items-center bg-[#0b1120] px-6 text-center text-slate-300">
            <div>
              <div className="mx-auto mb-4 h-9 w-9 animate-spin rounded-full border-2 border-white/20 border-t-[var(--accent)]" />
              <div className="text-sm">
                {status?.note || (status?.state === "running" ? "正在连接…" : isBrowser ? "正在启动浏览器…" : "正在启动应用…")}
              </div>
              <div className="mt-2 text-xs text-slate-500">首次使用需要安装图形环境{isBrowser ? "和浏览器" : ""}，请稍候</div>
            </div>
          </div>
        )}
        {phase === "ended" && (
          <div className="absolute inset-0 overflow-y-auto bg-[#0b1120] px-6 py-8 text-slate-300">
            <div className="mx-auto max-w-xl text-center">
              <div className="mb-2 text-4xl">{status?.state === "failed" ? "⚠️" : "💤"}</div>
              <div className="text-sm">{err || "应用已退出"}</div>
              {status?.exitCode !== null && status?.exitCode !== undefined && status.exitCode !== 0 && (
                <div className="mt-1 text-xs text-slate-500">退出代码 {status.exitCode}</div>
              )}
              {status?.log && (
                <pre className="mt-4 max-h-56 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-black/40 p-3 text-left text-xs text-slate-400">
                  {status.log.trim()}
                </pre>
              )}
              <div className="mt-5 flex justify-center gap-2">
                <button
                  onClick={() => setRunKey((k) => k + 1)}
                  className="rounded-lg bg-[var(--accent)] px-5 py-2 text-sm font-medium text-white"
                >
                  重新启动
                </button>
                <button
                  onClick={() => wmRef.current.close(winId)}
                  className="rounded-lg bg-white/10 px-5 py-2 text-sm hover:bg-white/20"
                >
                  关闭窗口
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {ime && phase === "running" && (
        <form
          className="flex shrink-0 items-center gap-2 border-t border-white/10 bg-slate-900 px-3 py-2"
          onSubmit={(e) => {
            e.preventDefault();
            sendIme();
          }}
        >
          <input
            ref={imeRef}
            data-ime
            value={imeText}
            onChange={(e) => setImeText(e.target.value)}
            placeholder="用输入法输入文字，回车发送到光标处"
            autoComplete="off"
            className="min-w-0 flex-1 rounded-lg border border-white/10 bg-black/30 px-3 py-1.5 text-sm outline-none focus:border-[var(--accent)]"
          />
          <button type="submit" disabled={!imeText} className="rounded-lg bg-[var(--accent)] px-4 py-1.5 text-sm font-medium text-white disabled:opacity-40">
            发送
          </button>
          <button
            type="button"
            title="发送回车键"
            onClick={() => rfbRef.current?.sendKey(0xff0d, "Enter")}
            className="rounded-lg bg-white/10 px-3 py-1.5 text-sm hover:bg-white/20"
          >
            ↵
          </button>
          <button
            type="button"
            title="发送退格键"
            onClick={() => rfbRef.current?.sendKey(0xff08, "Backspace")}
            className="rounded-lg bg-white/10 px-3 py-1.5 text-sm hover:bg-white/20"
          >
            ⌫
          </button>
        </form>
      )}
    </div>
  );
}
