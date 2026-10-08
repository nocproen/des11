import http from "http";
import type { Duplex } from "stream";
import { WebSocketServer, type WebSocket } from "ws";
import {
  closeSession,
  getSession,
  handleInput,
  touch,
  waitFrame,
  waitMeta,
  type Session,
} from "@/lib/remote-browser";
import { desktopAuthedHeader } from "@/lib/auth";
import { GUI_PATH, guiUpgrade } from "@/lib/gui";
import { TERM_PATH, termUpgrade } from "@/lib/term-ws";
import {
  applyRects,
  decode,
  diffRects,
  encodeFull,
  encodeRects,
  encodeScaled,
  pack,
  sameSize,
  type Raw,
} from "@/lib/tiles";

// 在 Next 自带的 HTTP 服务器上挂一条 WebSocket 通道：
// 服务器 -> 浏览器：二进制 = 画面更新（差分矩形 / 整帧，格式见 tiles.ts），文本 = 元数据(JSON)
// 浏览器 -> 服务器：文本 = 输入事件(JSON)

const WS_PATH = "/api/browser/ws";
const holder = globalThis as unknown as { __wdWs?: { servers: WeakSet<http.Server>; timer?: NodeJS.Timeout } };
const state = (holder.__wdWs ??= { servers: new WeakSet() });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isOurs = (req: http.IncomingMessage) => {
  try {
    const p = new URL(req.url ?? "/", "http://x").pathname;
    return p === WS_PATH || p === TERM_PATH || p === GUI_PATH;
  } catch {
    return false;
  }
};

// 整帧画质档位（只影响整屏变化，如滚动 / 翻页）；局部变化永远用高质量小矩形
const LEVELS = [
  { q: 70, s: 1 }, // 0 = 直接转发原始画面
  { q: 58, s: 1 },
  { q: 48, s: 0.85 },
  { q: 40, s: 0.7 },
  { q: 32, s: 0.55 },
  { q: 26, s: 0.45 },
];
const MAX_LEVEL = LEVELS.length - 1;
const gCost = (l: number) => LEVELS[l].s ** 2 * (LEVELS[l].q / 60) ** 1.3;
const TILE_QUALITY = 80;
// 关闭拥塞控制仅用于对比测试（等同旧版行为）
const CC_DEFAULT = process.env.BROWSER_CC !== "off";

function connection(ws: WebSocket, s: Session, CC: boolean, cookie: string | undefined) {
  const ac = new AbortController();
  let paused = false;
  let alive = true;
  let lastPong = Date.now();
  let lastInputAt = 0;
  let lastWheelAt = 0;

  /* ---------- 拥塞控制状态 ---------- */
  let level = 2;
  const inflight = new Map<number, { t: number; bytes: number; alone: boolean; full: boolean; level: number }>();
  let inflightBytes = 0;
  let nextId = 1;
  let srtt = 0;
  let minRtt = Infinity;
  let pingRtt = 0;
  let prevAckAt = 0;
  let samples: { t: number; v: number }[] = [];
  let bw = 0;
  let avgMsg = 0;
  let lastLevelAt = Date.now();
  let ackSeen = false;
  let legacy = !CC;
  let boostUntil = 0;
  let ackWaiter: (() => void) | null = null;
  const win = { frames: 0, bytes: 0 };
  let pingId = 0;
  const pings = new Map<number, number>();
  let pongs = 0;
  let warmResolve: () => void = () => {};
  const warmReady = new Promise<void>((r) => {
    warmResolve = r;
    setTimeout(r, 900);
  });

  // 客户端当前显示的画面（原始分辨率）；blurry = 当前整帧是降采样的，静止后需要补发清晰版
  let prev: Raw | null = null;
  let blurry = false;
  let fullRef: { level: number; bytes: number } | null = null;
  let sharpenY = 0; // 分条补发清晰画面的进度
  let lastChangeAt = 0; // 最近一次真实画面变化（相同内容的重复帧不算）
  let decoded: { buf: Buffer; raw: Raw } | null = null;

  const baseRtt = () => (Number.isFinite(minRtt) ? minRtt : 60);

  // 估算：以当前带宽，哪一档的整帧能在约 85ms 内传完
  const pickLevel = () => {
    if (!bw) return level;
    if (!fullRef) return 3;
    const budget = bw * 0.085;
    for (let l = 0; l <= MAX_LEVEL; l++) {
      if (fullRef.bytes * (gCost(l) / gCost(fullRef.level)) <= budget) return l;
    }
    return MAX_LEVEL;
  };

  const canSend = (bytes: number) => {
    if (legacy || inflight.size === 0) return true;
    if (inflight.size >= 12) return false;
    if (!bw) return inflight.size < 3;
    const boost = Date.now() < boostUntil ? 2.2 : 1;
    const limit = bw * 1.05 * (baseRtt() / 1000 + 0.06) * boost;
    return inflightBytes + bytes <= limit;
  };

  const onAck = (id: number) => {
    const f = inflight.get(id);
    if (!f) return;
    inflight.delete(id);
    inflightBytes -= f.bytes;
    ackSeen = true;
    const now = Date.now();
    const rtt = now - f.t;
    srtt = srtt ? srtt * 0.75 + rtt * 0.25 : rtt;
    if (prevAckAt && f.t < prevAckAt) {
      samples.push({ t: now, v: Math.min(200e6, (f.bytes / Math.max(1, now - prevAckAt)) * 1000) });
    } else if (f.alone && f.bytes > 6000 && rtt > baseRtt() + 40) {
      samples.push({ t: now, v: Math.min(200e6, (f.bytes / Math.max(1, rtt - baseRtt())) * 1000) });
    }
    prevAckAt = now;
    samples = samples.filter((x) => now - x.t < 5000);
    if (samples.length) bw = Math.max(...samples.map((x) => x.v));

    if (CC && f.full) {
      fullRef =
        fullRef && fullRef.level === f.level
          ? { level: f.level, bytes: fullRef.bytes * 0.6 + f.bytes * 0.4 }
          : { level: f.level, bytes: f.bytes };
      const target = pickLevel();
      if (target > level) {
        level = target;
        lastLevelAt = now;
      } else if (target < level && now - lastLevelAt > 2000) {
        level--;
        lastLevelAt = now;
      }
    }
    if (CC && srtt > baseRtt() * 3 + 500 && now - lastLevelAt > 700 && level < MAX_LEVEL) {
      level++;
      lastLevelAt = now;
    }
    const w = ackWaiter;
    ackWaiter = null;
    w?.();
  };

  const sendPing = () => {
    const id = ++pingId;
    pings.set(id, Date.now());
    if (pings.size > 20) pings.delete(pings.keys().next().value as number);
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ k: "ping", id }));
  };

  ws.on("pong", () => {
    lastPong = Date.now();
    touch(s);
  });
  const ping = setInterval(() => {
    if (Date.now() - lastPong > 45_000) return ws.terminate();
    try {
      ws.ping();
    } catch {
      /* ignore */
    }
  }, 15_000);
  const probe = setInterval(sendPing, 2000);
  // 登录失效（密码到期 / 被强制下线 / 改了密码）时立即断开并关闭这个浏览器会话
  const authTimer = setInterval(() => {
    void desktopAuthedHeader(cookie).then((ok) => {
      if (ok || !alive) return;
      void closeSession(s);
      try {
        ws.close(4001, "auth");
      } catch {
        /* ignore */
      }
    });
  }, 5000);
  const warm = [0, 120, 260].map((d) => setTimeout(sendPing, d));

  const statsTimer = setInterval(() => {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(
      JSON.stringify({
        k: "stats",
        rtt: Math.round(pingRtt || srtt),
        fps: win.frames,
        kbps: Math.round(win.bytes / 1024),
        level,
        bw: Math.round(bw / 1024),
      }),
    );
    win.frames = 0;
    win.bytes = 0;
  }, 1000);

  const close = () => {
    if (!alive) return;
    alive = false;
    clearInterval(ping);
    clearInterval(probe);
    clearInterval(authTimer);
    clearInterval(statsTimer);
    warm.forEach(clearTimeout);
    ac.abort();
    ackWaiter?.();
  };
  ws.on("close", close);
  ws.on("error", close);

  ws.on("message", (data, isBinary) => {
    if (isBinary) return;
    touch(s);
    let m: Record<string, unknown> | Record<string, unknown>[];
    try {
      m = JSON.parse(data.toString());
    } catch {
      return;
    }
    const list = Array.isArray(m) ? m : [m];
    const rest: Record<string, unknown>[] = [];
    for (const e of list) {
      switch (e.type) {
        case "ack":
          onAck(Number(e.id));
          continue;
        case "pong": {
          const t = pings.get(Number(e.id));
          if (t) {
            pings.delete(Number(e.id));
            pingRtt = Date.now() - t;
            if (pingRtt < minRtt) minRtt = pingRtt;
            if (++pongs >= 2) warmResolve();
          }
          continue;
        }
        case "visible":
          paused = !e.v;
          if (!paused) prev = null; // 恢复后整帧重发，保证画面一致
          continue;
        case "wheel": {
          const now = Date.now();
          if (CC && now - lastWheelAt > 800) {
            const t = pickLevel();
            if (t > level) {
              level = t;
              lastLevelAt = now;
            }
          }
          lastWheelAt = now;
          break;
        }
        case "press":
        case "text":
        case "down":
        case "up":
          boostUntil = Date.now() + 500; // 键盘 / 点击后优先送出结果画面
      }
      lastInputAt = Date.now();
      rest.push(e);
    }
    if (!rest.length) return;
    void handleInput(s, rest).then((out) => {
      if (out.selection && ws.readyState === ws.OPEN) ws.send(JSON.stringify({ k: "selection", text: out.selection }));
    });
  });

  /* ---------- 构造一次画面更新 ---------- */
  type Built = { msg: Buffer; full: boolean; level: number };
  const build = async (buf: Buffer, y: number, sharpen: boolean): Promise<Built | null> => {
    const id = nextId++;
    const cur = decoded && decoded.buf === buf ? decoded.raw : await decode(buf);
    decoded = { buf, raw: cur };
    const W = cur.w;
    const H = cur.h;

    if (sharpen) {
      // 把清晰画面切成若干条，每次只发一条，保证每条都在带宽预算内、不堵住后续操作
      const limit = bw ? bw * 0.15 : Infinity;
      const n = Math.min(12, Math.max(1, Math.ceil(buf.length / limit)));
      if (n === 1) {
        blurry = false;
        sharpenY = 0;
        prev = cur;
        return { msg: pack(id, true, W, H, y, [{ x: 0, y: 0, w: W, h: H, data: buf }]), full: true, level: 0 };
      }
      const bh = Math.ceil(H / n);
      const y0 = Math.min(sharpenY, H - 1);
      const band = { x: 0, y: y0, w: W, h: Math.min(bh, H - y0) };
      const pieces = await encodeRects(cur, [band], 66, "4:2:0");
      sharpenY = y0 + band.h;
      if (sharpenY >= H) {
        sharpenY = 0;
        blurry = false;
      }
      prev = cur;
      return { msg: pack(id, false, W, H, y, pieces), full: false, level };
    }
    const diff = sameSize(prev, cur) ? diffRects(prev, cur) : "full";
    if (diff !== "full") {
      if (!diff.length) return null; // 没有可见变化（不重置补发进度）
      sharpenY = 0;
      lastChangeAt = Date.now();
      const pieces = await encodeRects(cur, diff, TILE_QUALITY);
      applyRects(prev!, cur, diff);
      return { msg: pack(id, false, W, H, y, pieces), full: false, level };
    }

    sharpenY = 0;
    lastChangeAt = Date.now();
    const lv = LEVELS[CC ? level : 0];
    let out = buf;
    if (CC && level > 0) {
      out = (await encodeScaled(cur, lv.s, lv.q)).data;
      blurry = true;
    } else blurry = false;
    prev = cur;
    return { msg: pack(id, true, W, H, y, [{ x: 0, y: 0, w: W, h: H, data: out }]), full: true, level: CC ? level : 0 };
  };

  // 画面推送：事件驱动，只处理最新帧，受发送窗口限制
  void (async () => {
    let seq = 0;
    await warmReady; // 先测出空闲链路的基础往返，再开始推画面
    while (alive && !s.closed) {
      if (paused) {
        seq = 0;
        await sleep(150);
        continue;
      }
      const f0 = await waitFrame(s, seq, ac.signal, 220);
      if (!alive) break;
      let sharpen = false;
      if (!f0) {
        const idle = Date.now() - lastChangeAt > 350 && Date.now() - lastInputAt > 300;
        if (CC && blurry && idle && inflight.size === 0 && s.frame) sharpen = true;
        else continue;
      }

      const est = Math.min(s.frame?.length ?? 0, avgMsg || (s.frame?.length ?? 0));
      const waitStart = Date.now();
      while (alive && !canSend(est)) {
        await new Promise<void>((r) => {
          ackWaiter = r;
          setTimeout(r, 200);
        });
        const waited = Date.now() - waitStart;
        if (!ackSeen && waited > 1500) {
          legacy = true; // 旧版客户端不会发确认：退回无窗口模式
          break;
        }
        if (waited > 3500) {
          inflight.clear(); // 确认丢失：重置窗口避免卡死
          inflightBytes = 0;
          break;
        }
      }
      if (!alive) break;
      const buf = s.frame;
      if (!buf) continue;
      const y = s.frameY;
      seq = s.seq;

      let built: Built | null = null;
      try {
        built = await build(buf, y, sharpen);
      } catch {
        prev = null; // 解码失败：下一帧整帧重发
        continue;
      }
      if (!built || !alive) continue;
      const id = built.msg.readUInt32BE(0);
      ws.send(built.msg, { binary: true, compress: false });
      inflight.set(id, {
        t: Date.now(),
        bytes: built.msg.length,
        alone: inflight.size === 0,
        full: built.full,
        level: built.level,
      });
      inflightBytes += built.msg.length;
      avgMsg = avgMsg ? avgMsg * 0.7 + built.msg.length * 0.3 : built.msg.length;
      win.frames++;
      win.bytes += built.msg.length;
    }
  })();

  // 元数据推送（标签页、标题、地址、通知）
  void (async () => {
    let v = 0;
    while (alive && !s.closed) {
      const m = await waitMeta(s, v, ac.signal);
      if (!alive) break;
      if (m.v === v) continue;
      v = m.v;
      ws.send(JSON.stringify({ k: "meta", ...m }));
    }
    if (alive && s.closed) {
      try {
        ws.close(4000, "session closed");
      } catch {
        /* ignore */
      }
    }
  })();
}

function attach(server: http.Server) {
  if (state.servers.has(server)) return;
  state.servers.add(server);

  const wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: 4 * 1024 * 1024,
    // noVNC 会声明 "binary" 子协议，服务器必须选中它，否则浏览器会拒绝连接
    handleProtocols: (protocols) => (protocols.has("binary") ? "binary" : false),
  });
  const onUpgrade = async (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
    if (!isOurs(req)) return;
    // 终端与浏览器通道都必须已登录桌面
    if (!(await desktopAuthedHeader(req.headers.cookie))) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === TERM_PATH) return termUpgrade(wss, req, socket, head, url);
    if (url.pathname === GUI_PATH) return guiUpgrade(wss, req, socket, head, url);
    const s = getSession(url.searchParams.get("sid") ?? "");
    if (!s) {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      (socket as import("net").Socket).setNoDelay?.(true);
      touch(s);
      connection(ws, s, CC_DEFAULT && url.searchParams.get("cc") !== "off", req.headers.cookie);
    });
  };

  // 让 Next 自己的 upgrade 监听器忽略我们的路径
  type Listener = (req: http.IncomingMessage, socket: Duplex, head: Buffer) => void;
  const guard = (l: Listener): Listener =>
    function (this: unknown, req, socket, head) {
      if (isOurs(req)) return;
      return l.call(this, req, socket, head);
    };
  const existing = server.listeners("upgrade") as Listener[];
  server.removeAllListeners("upgrade");
  server.on("upgrade", onUpgrade);
  for (const l of existing) server.on("upgrade", guard(l));

  const origOn = server.on.bind(server);
  const wrap = (name: "on" | "addListener" | "prependListener" | "once") => {
    const orig = (server[name] as (e: string, l: (...a: never[]) => void) => http.Server).bind(server);
    (server as unknown as Record<string, unknown>)[name] = (event: string, l: (...a: never[]) => void) =>
      orig(event, event === "upgrade" ? (guard(l as unknown as Listener) as unknown as (...a: never[]) => void) : l);
  };
  void origOn;
  for (const n of ["on", "addListener", "prependListener", "once"] as const) wrap(n);
}

export function installBrowserWs() {
  const find = () => {
    const handles = (process as unknown as { _getActiveHandles?: () => unknown[] })._getActiveHandles?.() ?? [];
    let found = 0;
    for (const h of handles) {
      if (h instanceof http.Server) {
        attach(h);
        found++;
      }
    }
    return found;
  };
  if (find()) return;
  let tries = 0;
  const t = setInterval(() => {
    if (find() || ++tries > 100) clearInterval(t);
  }, 200);
  t.unref?.();
}
