"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useDialogs } from "../dialogs";
import { useWm, type Win } from "../wm-store";

type TabInfo = {
  id: number;
  title: string;
  url: string;
  loading: boolean;
  back: boolean;
  fwd: boolean;
};
type Meta = {
  v: number;
  active: number;
  tabs: TabInfo[];
  events: { id: number; kind: string; text: string }[];
  note: string | null;
};
type Ev = Record<string, unknown>;

const LINKS = [
  { name: "必应", url: "https://www.bing.com/", icon: "🔎" },
  { name: "百度", url: "https://www.baidu.com/", icon: "🐾" },
  { name: "谷歌", url: "https://www.google.com/", icon: "🌈" },
  { name: "维基百科", url: "https://zh.wikipedia.org/", icon: "📚" },
  { name: "GitHub", url: "https://github.com/", icon: "🐙" },
  { name: "YouTube", url: "https://www.youtube.com/", icon: "▶️" },
  { name: "Hacker News", url: "https://news.ycombinator.com/", icon: "🟧" },
  { name: "MDN", url: "https://developer.mozilla.org/zh-CN/", icon: "🧭" },
];

const SEARCH = "https://www.bing.com/search?q=";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function normalize(input: string): string {
  const t = input.trim();
  if (!t) return "";
  if (/^https?:\/\//i.test(t)) return t;
  if (/^(localhost|(\d{1,3}\.){3}\d{1,3})(:\d+)?([/?#].*)?$/i.test(t)) return "http://" + t;
  if (/^[^\s/]+\.[a-z]{2,}(:\d+)?([/?#]\S*)?$/i.test(t)) return "https://" + t;
  return SEARCH + encodeURIComponent(t);
}

export function BrowserApp({ win }: { win: Win }) {
  const dlg = useDialogs();
  const wm = useWm();
  const initialUrl = win.path;

  const [state, setState] = useState<"starting" | "ready" | "error" | "lost">("starting");
  const [errMsg, setErrMsg] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [addr, setAddr] = useState("");
  const [editing, setEditing] = useState(false);
  const [startKey, setStartKey] = useState(0);

  const viewRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const addrRef = useRef<HTMLInputElement>(null);
  const sidRef = useRef<string | null>(null);
  const sizeRef = useRef({ w: 0, h: 0 });
  const hiddenRef = useRef(false);
  const queue = useRef<Ev[]>([]);
  const sending = useRef(false);
  const toastRef = useRef(dlg.toast);
  toastRef.current = dlg.toast;

  const active = meta?.tabs.find((t) => t.id === meta.active);
  const isBlank = !active || active.url === "" || active.url === "about:blank";

  /* ---------- 发送输入：WebSocket 直发；回退时走 HTTP 队列 ---------- */
  const wsRef = useRef<WebSocket | null>(null);
  const motion = useRef<{ move: Ev | null; wheel: Ev | null; raf: number }>({ move: null, wheel: null, raf: 0 });
  const [transport, setTransport] = useState<"ws" | "http">("http");
  const rttRef = useRef(100);
  const blankRef = useRef(true);
  blankRef.current = isBlank;
  // 滚动预测：滚轮一动就在本地先把当前画面平移，真实画面到达后再对齐
  const sc = useRef({ cum: 0, baseY: 0, baseCum: 0, ySrv: 0, lastWheelAt: 0, noPredUntil: 0, strikes: 0, shift: 0 });
  const setShift = useCallback((v: number) => {
    const c = canvasRef.current;
    const r = Math.round(v);
    if (!c || sc.current.shift === r) return;
    sc.current.shift = r;
    c.style.transform = r ? `translate3d(0,${-r}px,0)` : "";
  }, []);
  const scrollFrame = useCallback(
    (y: number) => {
      const s = sc.current;
      s.ySrv = y;
      if (Math.abs(s.cum - s.baseCum) < 0.5) {
        s.baseY = y;
        s.baseCum = s.cum;
        setShift(0);
        return;
      }
      const now = performance.now();
      if (now - s.lastWheelAt > rttRef.current + 110) {
        // 这一帧一定包含了全部滚动：以它为准，并检查页面是否真的滚动了
        const req = s.cum - s.baseCum;
        const expected = Math.max(0, s.baseY + req) - s.baseY;
        if (Math.abs(expected) >= 20) {
          if (Math.abs(y - s.baseY) < 2) {
            s.strikes++;
            s.noPredUntil = now + Math.min(60000, 1500 * 2 ** s.strikes);
          } else s.strikes = 0;
        }
        s.baseY = y;
        s.baseCum = s.cum;
        setShift(0);
        return;
      }
      const h = viewRef.current?.clientHeight ?? 600;
      setShift(Math.max(-h, Math.min(h, Math.max(0, s.baseY + (s.cum - s.baseCum)) - y)));
    },
    [setShift],
  );
  const predictWheel = useCallback(
    (dy: number) => {
      const s = sc.current;
      const now = performance.now();
      if (now < s.noPredUntil || Math.abs(dy) < 1) return;
      if (Math.abs(s.cum - s.baseCum) < 0.5) {
        s.baseY = s.ySrv;
        s.baseCum = s.cum;
      }
      s.cum += dy;
      s.lastWheelAt = now;
      const h = viewRef.current?.clientHeight ?? 600;
      setShift(Math.max(-h, Math.min(h, Math.max(0, s.baseY + (s.cum - s.baseCum)) - s.ySrv)));
    },
    [setShift],
  );
  const [hud, setHud] = useState<{ rtt: number; fps: number; kbps: number; level: number } | null>(null);

  const flush = useCallback(async () => {
    if (sending.current) return;
    sending.current = true;
    try {
      while (queue.current.length && sidRef.current) {
        const raw = queue.current.splice(0, 60);
        const batch = raw.filter((e, i) => !(e.type === "move" && raw[i + 1]?.type === "move"));
        try {
          const r = await fetch(`/api/browser/${sidRef.current}/input`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ events: batch }),
          });
          if (r.status === 404) setState("lost");
          else if (r.ok) {
            const d = (await r.json()) as { selection?: string };
            if (d.selection) copyText(d.selection);
          }
        } catch {
          /* 网络抖动，丢弃本批 */
        }
      }
    } finally {
      sending.current = false;
    }
  }, []);

  const copyText = (text: string) =>
    navigator.clipboard?.writeText(text).then(
      () => toastRef.current("已复制"),
      () => {},
    );

  const rawSend = useCallback(
    (ev: Ev) => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(ev));
      } else {
        queue.current.push(ev);
        void flush();
      }
    },
    [flush],
  );

  // 鼠标移动 / 滚轮按显示器刷新率合并，其余事件立即发送（先冲刷未发出的移动，保证顺序）
  const flushMotion = useCallback(() => {
    const m = motion.current;
    m.raf = 0;
    if (m.move) {
      const ev = m.move;
      m.move = null;
      rawSend(ev);
    }
    if (m.wheel) {
      const ev = m.wheel;
      m.wheel = null;
      rawSend(ev);
    }
  }, [rawSend]);

  const send = useCallback(
    (ev: Ev) => {
      const m = motion.current;
      if (ev.type === "move") {
        m.move = ev;
      } else if (ev.type === "wheel") {
        if (m.wheel) {
          m.wheel = {
            ...ev,
            dx: Number(m.wheel.dx) + Number(ev.dx),
            dy: Number(m.wheel.dy) + Number(ev.dy),
          };
        } else m.wheel = ev;
      } else {
        flushMotion();
        rawSend(ev);
        return;
      }
      if (!m.raf) m.raf = requestAnimationFrame(flushMotion);
    },
    [flushMotion, rawSend],
  );

  /* ---------- 会话生命周期 ---------- */
  useEffect(() => {
    let dead = false;
    let mySid: string | null = null;

    // 画面更新必须按顺序合成（差分矩形依赖前一状态）；整帧到达时可丢弃更早的排队更新
    type Piece = { x: number; y: number; w: number; h: number; blob: Blob };
    type Upd = { full: boolean; W: number; H: number; y: number | null; pieces: Piece[] };
    const upQ: Upd[] = [];
    let applying = false;
    let lastEv = 0;
    const applyLoop = async () => {
      applying = true;
      while (upQ.length && !dead) {
        const u = upQ.shift()!;
        try {
          const bmps = await Promise.all(u.pieces.map((p) => createImageBitmap(p.blob)));
          const c = canvasRef.current;
          if (c && !dead) {
            const ctx = c.getContext("2d");
            const sx = c.width / u.W;
            const sy = c.height / u.H;
            u.pieces.forEach((p, i) => {
              const dx = Math.floor(p.x * sx);
              const dy = Math.floor(p.y * sy);
              ctx?.drawImage(bmps[i], dx, dy, Math.ceil((p.x + p.w) * sx) - dx, Math.ceil((p.y + p.h) * sy) - dy);
            });
            if (u.y !== null) scrollFrame(u.y);
          }
          bmps.forEach((b) => b.close());
        } catch {
          /* 坏帧忽略 */
        }
      }
      applying = false;
    };
    const enqueue = (u: Upd) => {
      if (u.full) upQ.length = 0;
      upQ.push(u);
      if (!applying) void applyLoop();
    };
    // HTTP 回退路径：整帧 JPEG
    const onFrame = (blob: Blob) => {
      const c = canvasRef.current;
      const W = c?.width || 1;
      const H = c?.height || 1;
      enqueue({ full: true, W, H, y: null, pieces: [{ x: 0, y: 0, w: W, h: H, blob }] });
    };
    const applyMeta = (m: Meta) => {
      setMeta(m);
      for (const e of m.events) {
        if (e.id > lastEv) {
          lastEv = e.id;
          toastRef.current(e.text);
        }
      }
    };

    const connectWs = (id: string) =>
      new Promise<boolean>((resolve) => {
        let opened = false;
        let settled = false;
        const done = (ok: boolean) => {
          if (!settled) {
            settled = true;
            resolve(ok);
          }
        };
        let ws: WebSocket;
        try {
          ws = new WebSocket(
            `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/browser/ws?sid=${id}${localStorage.getItem("wdCC") === "off" ? "&cc=off" : ""}`,
          );
        } catch {
          return done(false);
        }
        ws.binaryType = "arraybuffer";
        const timer = setTimeout(() => {
          if (!opened) {
            ws.close();
            done(false);
          }
        }, 5000);
        ws.onopen = () => {
          opened = true;
          clearTimeout(timer);
          wsRef.current = ws;
          setTransport("ws");
          done(true);
        };
        ws.onmessage = (e) => {
          if (typeof e.data === "string") {
            try {
              const m = JSON.parse(e.data) as { k: string; text?: string; id?: number } & Record<string, unknown>;
              if (m.k === "meta") applyMeta(m as unknown as Meta);
              else if (m.k === "ping") ws.send(`{"type":"pong","id":${m.id}}`);
              else if (m.k === "stats") {
                rttRef.current = Number(m.rtt) || rttRef.current;
                setHud({
                  rtt: Number(m.rtt),
                  fps: Number(m.fps),
                  kbps: Number(m.kbps),
                  level: Number(m.level),
                });
              } else if (m.k === "selection" && m.text) void copyText(m.text);
            } catch {
              /* ignore */
            }
          } else {
            // 收到立即确认（服务器据此测带宽 / 延迟），再解析并合成
            const buf = e.data as ArrayBuffer;
            if (buf.byteLength < 14) return;
            const dv = new DataView(buf);
            ws.send(`{"type":"ack","id":${dv.getUint32(0)}}`);
            const n = dv.getUint8(13);
            const pieces: Piece[] = [];
            let o = 14;
            for (let i = 0; i < n && o + 12 <= buf.byteLength; i++) {
              const len = dv.getUint32(o + 8);
              pieces.push({
                x: dv.getUint16(o),
                y: dv.getUint16(o + 2),
                w: dv.getUint16(o + 4),
                h: dv.getUint16(o + 6),
                blob: new Blob([new Uint8Array(buf, o + 12, len)], { type: "image/jpeg" }),
              });
              o += 12 + len;
            }
            enqueue({
              full: (dv.getUint8(4) & 1) === 1,
              W: dv.getUint16(5) || 1,
              H: dv.getUint16(7) || 1,
              y: dv.getFloat32(9),
              pieces,
            });
          }
        };
        ws.onclose = () => {
          clearTimeout(timer);
          if (wsRef.current === ws) wsRef.current = null;
          if (!opened) return done(false);
          if (dead) return;
          // 连接中断：回退到 HTTP 轮询（会话若已结束会得到 404 -> 提示重新启动）
          setTransport("http");
          setHud(null);
          void frameLoop(id);
          void metaLoop(id);
        };
        ws.onerror = () => {};
      });

    const frameLoop = async (id: string) => {
      let seq = 0;
      while (!dead) {
        if (hiddenRef.current || document.hidden) {
          seq = 0;
          await sleep(300);
          continue;
        }
        try {
          const r = await fetch(`/api/browser/${id}/frame?seq=${seq}`, { cache: "no-store" });
          if (r.status === 404) {
            if (!dead) setState("lost");
            return;
          }
          if (r.status === 204) continue;
          if (!r.ok) {
            await sleep(600);
            continue;
          }
          seq = Number(r.headers.get("X-Seq") ?? seq);
          onFrame(await r.blob());
        } catch {
          if (!dead) await sleep(800);
        }
      }
    };

    const metaLoop = async (id: string) => {
      let v = 0;
      while (!dead) {
        try {
          const r = await fetch(`/api/browser/${id}/meta?v=${v}`, { cache: "no-store" });
          if (r.status === 404) {
            if (!dead) setState("lost");
            return;
          }
          if (!r.ok) {
            await sleep(800);
            continue;
          }
          const m = (await r.json()) as Meta;
          if (dead) return;
          v = m.v;
          applyMeta(m);
        } catch {
          if (!dead) await sleep(800);
        }
      }
    };

    (async () => {
      setState("starting");
      setMeta(null);
      setNote(null);
      const r = viewRef.current?.getBoundingClientRect();
      const w = Math.round(r?.width || 900);
      const h = Math.round(r?.height || 500);
      sizeRef.current = { w, h };
      const c = canvasRef.current;
      if (c) {
        c.width = w;
        c.height = h;
      }
      try {
        const res = await fetch("/api/browser", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key: win.id, w, h, url: initialUrl }), // 窗口 id：多个浏览器共享同一个会话
        });
        const d = (await res.json()) as { sid?: string; error?: string };
        if (!res.ok || !d.sid) throw new Error(d.error ?? "启动失败");
        if (dead) {
          // Do not terminate a session being viewed by another browser.
          return;
        }
        mySid = d.sid;
        sidRef.current = d.sid;
        setState("ready");
        taRef.current?.focus({ preventScroll: true });
        if (!(await connectWs(d.sid)) && !dead) {
          // WebSocket 不可用（被代理拦截等）：回退到 HTTP 轮询
          void frameLoop(d.sid);
          void metaLoop(d.sid);
        }
      } catch (e) {
        if (!dead) {
          setErrMsg(e instanceof Error ? e.message : "启动失败");
          setState("error");
        }
      }
    })();

    return () => {
      dead = true;
      queue.current = [];
      sidRef.current = null;
      cancelAnimationFrame(motion.current.raf);
      motion.current = { move: null, wheel: null, raf: 0 };
      const ws = wsRef.current;
      wsRef.current = null;
      ws?.close();
      // Window-close commits, not viewer cleanup, own shared-session shutdown.
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startKey]);

  // 启动较慢时（首次下载内核），轮询提示
  useEffect(() => {
    if (state !== "starting") return;
    const t = setInterval(() => setNote("正在准备浏览器内核，首次使用可能需要一两分钟…"), 4000);
    return () => clearInterval(t);
  }, [state]);

  /* ---------- 窗口尺寸 -> 浏览器视口 ---------- */
  useEffect(() => {
    const el = viewRef.current;
    if (!el) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      const w = Math.round(r.width);
      const h = Math.round(r.height);
      const hidden = w < 50 || h < 50;
      if (hidden !== hiddenRef.current) {
        hiddenRef.current = hidden;
        const ws = wsRef.current;
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "visible", v: !hidden }));
      }
      if (hidden) return;
      if (w === sizeRef.current.w && h === sizeRef.current.h) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        sizeRef.current = { w, h };
        const c = canvasRef.current;
        if (c) {
          c.width = w;
          c.height = h;
        }
        send({ type: "resize", w, h });
      }, 180);
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      clearTimeout(timer);
    };
  }, [send]);

  // 滚轮需要非 passive 才能阻止页面滚动
  useEffect(() => {
    const el = viewRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? r.height : 1;
      if (sidRef.current && !blankRef.current) predictWheel(e.deltaY * k);
      send({ type: "wheel", x: e.clientX - r.left, y: e.clientY - r.top, dx: e.deltaX * k, dy: e.deltaY * k });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [send, predictWheel]);

  // 标题同步到窗口标题栏
  const activeTitle = active?.title || (isBlank ? "新标签页" : active?.url) || "浏览器";
  useEffect(() => {
    wm.patch(win.id, { title: activeTitle });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTitle]);

  useEffect(() => {
    if (!editing) setAddr(isBlank ? "" : (active?.url ?? ""));
  }, [active?.url, isBlank, editing]);

  /* ---------- 鼠标 / 触摸 ---------- */
  const clicks = useRef({ t: 0, x: 0, y: 0, n: 0 });
  const touch = useRef<{ x: number; y: number; sx: number; sy: number; moved: boolean } | null>(null);
  const downBtn = useRef<number | null>(null);

  const pos = (e: { clientX: number; clientY: number }) => {
    const r = viewRef.current!.getBoundingClientRect();
    return { x: Math.round(e.clientX - r.left), y: Math.round(e.clientY - r.top) };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (state !== "ready" || isBlank) return;
    taRef.current?.focus({ preventScroll: true });
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const p = pos(e);
    if (e.pointerType === "touch") {
      touch.current = { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, moved: false };
      return;
    }
    const now = Date.now();
    const c = clicks.current;
    c.n = now - c.t < 450 && Math.abs(p.x - c.x) < 6 && Math.abs(p.y - c.y) < 6 ? Math.min(3, c.n + 1) : 1;
    c.t = now;
    c.x = p.x;
    c.y = p.y;
    downBtn.current = e.button;
    send({ type: "down", ...p, button: e.button, clickCount: c.n });
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (state !== "ready" || isBlank) return;
    const p = pos(e);
    if (e.pointerType === "touch") {
      const t = touch.current;
      if (!t) return;
      if (Math.abs(e.clientX - t.sx) + Math.abs(e.clientY - t.sy) > 8) t.moved = true;
      if (t.moved) send({ type: "wheel", ...p, dx: t.x - e.clientX, dy: t.y - e.clientY });
      t.x = e.clientX;
      t.y = e.clientY;
      return;
    }
    send({ type: "move", ...p });
  };

  const onPointerUp = (e: React.PointerEvent) => {
    if (state !== "ready" || isBlank) return;
    const p = pos(e);
    if (e.pointerType === "touch") {
      const t = touch.current;
      touch.current = null;
      if (t && !t.moved) {
        send({ type: "down", ...p, button: 0, clickCount: 1 });
        send({ type: "up", ...p, button: 0, clickCount: 1 });
      }
      return;
    }
    if (downBtn.current === null) return;
    send({ type: "up", ...p, button: downBtn.current, clickCount: clicks.current.n });
    downBtn.current = null;
  };

  /* ---------- 键盘 / 输入法 / 粘贴 ---------- */
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (state !== "ready" || isBlank) return;
    const ne = e.nativeEvent;
    if (ne.isComposing || e.keyCode === 229) return;
    const k = e.key;
    if (k === "Shift" || k === "Control" || k === "Alt" || k === "Meta" || k === "CapsLock" || k === "Process") return;
    const mod = e.ctrlKey || e.metaKey;
    const lower = k.toLowerCase();
    if (mod && lower === "v") return; // 交给 paste 事件
    e.preventDefault();
    let key = k;
    if (mod) {
      key = `Control+${e.shiftKey && k.length > 1 ? "Shift+" : ""}${k}`;
      if (k.length === 1 && e.shiftKey) key = `Control+Shift+${lower}`;
    } else if (e.altKey && k.length === 1) {
      key = `Alt+${k}`;
    }
    send({ type: "press", key });
    if (mod && (lower === "c" || lower === "x")) {
      setTimeout(() => send({ type: "selection" }), 60);
    }
  };

  const onCompositionEnd = (e: React.CompositionEvent<HTMLTextAreaElement>) => {
    if (e.data) send({ type: "text", text: e.data });
    if (taRef.current) taRef.current.value = "";
  };

  const onPaste = (e: React.ClipboardEvent) => {
    e.preventDefault();
    const text = e.clipboardData.getData("text");
    if (text) send({ type: "text", text });
  };

  /* ---------- 工具栏动作 ---------- */
  const go = (raw: string) => {
    const u = normalize(raw);
    if (!u) return;
    send({ type: "goto", url: u });
    setEditing(false);
    addrRef.current?.blur();
    taRef.current?.focus({ preventScroll: true });
  };

  const newTab = () => {
    send({ type: "newtab" });
    setEditing(true);
    setAddr("");
    setTimeout(() => addrRef.current?.focus(), 120);
  };

  const btn =
    "grid h-8 w-8 shrink-0 place-items-center rounded-md text-base hover:bg-white/10 disabled:opacity-30 disabled:hover:bg-transparent";

  return (
    <div className="flex h-full flex-col bg-[#1e293b]">
      {/* 标签栏 */}
      <div className="flex items-end gap-0.5 overflow-x-auto bg-black/25 px-2 pt-1.5">
        {(meta?.tabs ?? []).map((t) => (
          <div
            key={t.id}
            onClick={() => send({ type: "switch", id: t.id })}
            className={`group flex h-8 w-44 shrink-0 cursor-default items-center gap-1.5 rounded-t-lg px-3 text-xs ${
              t.id === meta?.active ? "bg-[#1e293b] text-white" : "text-slate-400 hover:bg-white/5"
            }`}
          >
            <span className="shrink-0 text-[11px]">{t.loading ? "⏳" : "🌐"}</span>
            <span className="min-w-0 flex-1 truncate">
              {t.title || (t.url && t.url !== "about:blank" ? t.url : "新标签页")}
            </span>
            <button
              aria-label="关闭标签页"
              onClick={(e) => {
                e.stopPropagation();
                send({ type: "closetab", id: t.id });
              }}
              className="grid h-5 w-5 shrink-0 place-items-center rounded hover:bg-white/15"
            >
              ✕
            </button>
          </div>
        ))}
        <button
          onClick={newTab}
          disabled={state !== "ready"}
          title="新标签页"
          className="mb-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-md text-lg hover:bg-white/10 disabled:opacity-30"
        >
          ＋
        </button>
      </div>

      {/* 工具栏 */}
      <form
        className="flex items-center gap-1 border-b border-white/10 px-2 py-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          go(addr);
        }}
      >
        <button type="button" className={btn} disabled={!active?.back} onClick={() => send({ type: "back" })} title="后退">
          ←
        </button>
        <button type="button" className={btn} disabled={!active?.fwd} onClick={() => send({ type: "forward" })} title="前进">
          →
        </button>
        <button
          type="button"
          className={btn}
          disabled={state !== "ready" || isBlank}
          onClick={() => send({ type: active?.loading ? "stop" : "reload" })}
          title={active?.loading ? "停止" : "刷新"}
        >
          {active?.loading ? "✕" : "⟳"}
        </button>
        <button
          type="button"
          className={btn}
          disabled={state !== "ready"}
          onClick={() => send({ type: "goto", url: "about:blank" })}
          title="主页"
        >
          🏠
        </button>
        <input
          ref={addrRef}
          value={addr}
          onChange={(e) => setAddr(e.target.value)}
          onFocus={(e) => {
            setEditing(true);
            e.currentTarget.select();
          }}
          onBlur={() => setEditing(false)}
          placeholder="搜索或输入网址"
          spellCheck={false}
          autoCapitalize="off"
          disabled={state !== "ready"}
          className="mx-1 min-w-0 flex-1 rounded-full border border-white/10 bg-black/30 px-4 py-1.5 text-sm outline-none focus:border-[var(--accent)]"
        />
        <span
          data-hud
          title="实时：往返延迟 · 帧率 · 带宽 · 画质档位（档位越大画质越低，用来保证低延迟）"
          className="hidden shrink-0 whitespace-nowrap rounded-md bg-black/25 px-2 py-1 font-mono text-[10px] text-slate-400 sm:block"
        >
          {transport === "ws" && hud
            ? `${hud.rtt}ms · ${hud.fps}fps · ${hud.kbps}KB/s · Q${hud.level}`
            : transport === "ws"
              ? "已连接"
              : "HTTP 回退"}
        </span>
      </form>
      {active?.loading && (
        <div className="h-0.5 w-full overflow-hidden bg-white/5">
          <div className="h-full w-1/3 animate-[slide_1s_linear_infinite] bg-[var(--accent)]" />
        </div>
      )}

      {/* 画面区域 */}
      <div
        ref={viewRef}
        data-transport={transport}
        className="relative min-h-0 flex-1 touch-none overflow-hidden bg-white outline-none"
        onMouseDown={(e) => {
          // 阻止浏览器默认的焦点转移，保持隐藏输入框获得键盘焦点
          e.preventDefault();
          taRef.current?.focus({ preventScroll: true });
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onContextMenu={(e) => e.preventDefault()}
      >
        <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
        <textarea
          ref={taRef}
          onKeyDown={onKeyDown}
          onCompositionEnd={onCompositionEnd}
          onPaste={onPaste}
          aria-label="浏览器输入"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          className="absolute left-0 top-0 h-px w-px resize-none opacity-0"
        />

        {state === "ready" && isBlank && (
          <div className="absolute inset-0 overflow-y-auto bg-gradient-to-b from-slate-900 to-slate-800 px-6 py-10 text-slate-100">
            <div className="mx-auto max-w-2xl">
              <div className="mb-6 text-center text-3xl font-light tracking-wide">🌐 WebDesktop 浏览器</div>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  go(addr);
                }}
              >
                <input
                  value={addr}
                  onChange={(e) => setAddr(e.target.value)}
                  placeholder="搜索或输入网址…"
                  className="w-full rounded-full border border-white/15 bg-black/30 px-5 py-3 text-base outline-none focus:border-[var(--accent)]"
                />
              </form>
              <div className="mt-8 grid grid-cols-4 gap-3">
                {LINKS.map((l) => (
                  <button
                    key={l.url}
                    onClick={() => go(l.url)}
                    className="flex flex-col items-center gap-1.5 rounded-xl p-2 text-xs hover:bg-white/10"
                  >
                    <span className="grid h-12 w-12 place-items-center rounded-2xl bg-white/10 text-2xl">
                      {l.icon}
                    </span>
                    {l.name}
                  </button>
                ))}
              </div>
              <p className="mt-10 text-center text-xs text-slate-500">
                这是运行在服务器上的真实 Chromium，登录状态会保存。下载的文件保存在 ~/Downloads。
              </p>
            </div>
          </div>
        )}

        {state === "starting" && (
          <div className="absolute inset-0 grid place-items-center bg-slate-900 text-center text-slate-300">
            <div>
              <div className="mx-auto mb-4 h-8 w-8 animate-spin rounded-full border-2 border-white/20 border-t-[var(--accent)]" />
              <div className="text-sm">正在启动浏览器…</div>
              {note && <div className="mt-2 max-w-xs text-xs text-slate-500">{note}</div>}
            </div>
          </div>
        )}

        {(state === "error" || state === "lost") && (
          <div className="absolute inset-0 grid place-items-center bg-slate-900 px-6 text-center text-slate-300">
            <div>
              <div className="mb-2 text-4xl">{state === "lost" ? "💤" : "⚠️"}</div>
              <div className="text-sm">
                {state === "lost" ? "浏览器会话已结束（长时间无操作或服务重启）" : "浏览器启动失败"}
              </div>
              {state === "error" && <div className="mx-auto mt-2 max-w-md break-words text-xs text-red-300">{errMsg}</div>}
              <button
                onClick={() => setStartKey((k) => k + 1)}
                className="mt-4 rounded-lg bg-[var(--accent)] px-5 py-2 text-sm font-medium text-white"
              >
                重新启动
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
