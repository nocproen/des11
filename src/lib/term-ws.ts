import fsp from "fs/promises";
import type http from "http";
import path from "path";
import type { Duplex } from "stream";
import * as pty from "node-pty";
import type { WebSocket, WebSocketServer } from "ws";
import { desktopAuthedHeader } from "@/lib/auth";
import { cleanEnv, ensureBin } from "@/lib/proc-env";
import { HOME, ensureHome, resolveP } from "@/lib/sys";

// 真正的交互式终端：服务器上为每个窗口起一个伪终端(PTY)里的 bash，
// 通过 WebSocket 双向传输原始字节。因为有 TTY，所以 apt 的 [Y/n] 确认、
// vim / top / ssh / python 交互、方向键历史、Tab 补全、Ctrl+C 等都和本地终端一样。
//
// 浏览器 -> 服务器（文本 JSON）：{t:"i",d} 输入 | {t:"r",c,r} 调整大小 | {t:"kill"} 结束
// 服务器 -> 浏览器：二进制 = 终端输出原始字节；文本 JSON = {t:"exit",code}

export const TERM_PATH = "/api/term/ws";

type TermSession = {
  id: string;
  proc: pty.IPty;
  clients: Set<WebSocket>;
  chunks: Buffer[];
  size: number;
  killTimer?: NodeJS.Timeout;
  paused: boolean;
  exited: boolean;
  createdAt: number;
};

const holder = globalThis as unknown as { __wdTerm?: { sessions: Map<string, TermSession> } };
const G = (holder.__wdTerm ??= { sessions: new Map() });

const SCROLLBACK_BYTES = 256 * 1024; // 断线重连时回放的最近输出
const DETACH_MS = 2 * 60_000; // 无人连接后保留会话的时间
const MAX_SESSIONS = 10;
const HIGH_WATER = 2 * 1024 * 1024;
const LOW_WATER = 256 * 1024;

const clamp = (v: unknown, lo: number, hi: number, d: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : d;
};

// 结束终端：对整个进程组发信号。只杀 bash 不够——bash 会等前台命令（如 sleep / apt）跑完才响应挂断。
function hardKill(proc: pty.IPty) {
  const pid = proc.pid;
  try {
    process.kill(-pid, "SIGHUP");
  } catch {
    try {
      proc.kill();
    } catch {
      /* ignore */
    }
  }
  setTimeout(() => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      /* 已经退出 */
    }
  }, 1500).unref?.();
}

function removeSession(s: TermSession) {
  if (G.sessions.get(s.id) === s) G.sessions.delete(s.id);
  if (s.killTimer) clearTimeout(s.killTimer);
}

function broadcast(s: TermSession, data: Buffer) {
  s.chunks.push(data);
  s.size += data.length;
  while (s.size > SCROLLBACK_BYTES && s.chunks.length > 1) s.size -= s.chunks.shift()!.length;

  let congested = false;
  for (const ws of s.clients) {
    if (ws.readyState !== ws.OPEN) continue;
    ws.send(data, { binary: true });
    if (ws.bufferedAmount > HIGH_WATER) congested = true;
  }
  // 背压：客户端来不及接收时暂停 PTY 输出（比如 `yes` 或 `cat` 大文件），避免内存暴涨
  if (congested && !s.paused) {
    s.paused = true;
    s.proc.pause();
    const t = setInterval(() => {
      const worst = Math.max(0, ...[...s.clients].map((c) => (c.readyState === c.OPEN ? c.bufferedAmount : 0)));
      if (s.exited || worst < LOW_WATER || s.clients.size === 0) {
        clearInterval(t);
        s.paused = false;
        if (!s.exited) s.proc.resume();
      }
    }, 30);
  }
}

async function createSession(id: string, cols: number, rows: number, cwdRaw: string | null, initCmd: string | null) {
  if (G.sessions.size >= MAX_SESSIONS) {
    // 优先回收无人连接的旧会话
    const idle = [...G.sessions.values()].filter((x) => x.clients.size === 0).sort((a, b) => a.createdAt - b.createdAt)[0];
    if (!idle) throw new Error("终端数量已达上限，请先关闭一个");
    hardKill(idle.proc);
    removeSession(idle);
  }
  await ensureHome();
  const binDir = await ensureBin();

  let cwd = resolveP(cwdRaw);
  try {
    if (!(await fsp.stat(cwd)).isDirectory()) cwd = HOME;
  } catch {
    cwd = HOME;
  }

  const proc = pty.spawn("bash", ["--rcfile", path.join(HOME, ".webdesktop", "bashrc"), "-i"], {
    name: "xterm-256color",
    cols,
    rows,
    cwd,
    env: cleanEnv(binDir),
    encoding: null, // 以 Buffer 形式收发，避免多字节字符被截断
  });

  const s: TermSession = {
    id,
    proc,
    clients: new Set(),
    chunks: [],
    size: 0,
    paused: false,
    exited: false,
    createdAt: Date.now(),
  };
  G.sessions.set(id, s);
  if (initCmd) proc.write(initCmd + "\r");

  proc.onData((d) => broadcast(s, Buffer.isBuffer(d) ? d : Buffer.from(d as unknown as string)));
  proc.onExit(({ exitCode }) => {
    s.exited = true;
    removeSession(s);
    const msg = JSON.stringify({ t: "exit", code: exitCode });
    for (const ws of s.clients) {
      try {
        ws.send(msg);
        setTimeout(() => ws.close(1000, "exit"), 50);
      } catch {
        /* ignore */
      }
    }
    s.clients.clear();
  });
  return s;
}

function scheduleKill(s: TermSession) {
  if (s.killTimer) clearTimeout(s.killTimer);
  s.killTimer = setTimeout(() => {
    if (s.clients.size === 0 && !s.exited) {
      try {
        hardKill(s.proc);
      } catch {
        /* ignore */
      }
      removeSession(s);
    }
  }, DETACH_MS);
}

export function termUpgrade(
  wss: WebSocketServer,
  req: http.IncomingMessage,
  socket: Duplex,
  head: Buffer,
  url: URL,
) {
  const sid = url.searchParams.get("sid") ?? "";
  if (!/^[\w-]{8,64}$/.test(sid)) {
    socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  const cols = clamp(url.searchParams.get("cols"), 10, 500, 80);
  const rows = clamp(url.searchParams.get("rows"), 2, 200, 24);
  const cwd = url.searchParams.get("cwd");
  const cmdRaw = url.searchParams.get("cmd");
  const initCmd = cmdRaw && cmdRaw.length <= 4000 && !/[\r\n\0]/.test(cmdRaw) ? cmdRaw : null;

  wss.handleUpgrade(req, socket, head, (ws) => {
    (socket as import("net").Socket).setNoDelay?.(true);

    // 会话准备好之前到达的消息按顺序排队
    const ready: Promise<TermSession | null> = (async () => {
      let s = G.sessions.get(sid) ?? null;
      if (s && s.exited) s = null;
      if (!s) {
        try {
          s = await createSession(sid, cols, rows, cwd, initCmd);
        } catch (e) {
          ws.send(JSON.stringify({ t: "error", message: e instanceof Error ? e.message : "无法启动终端" }));
          ws.close(1011, "error");
          return null;
        }
      } else {
        try {
          s.proc.resize(cols, rows);
        } catch {
          /* ignore */
        }
      }
      if (s.killTimer) clearTimeout(s.killTimer);
      s.clients.add(ws);
      if (s.chunks.length && ws.readyState === ws.OPEN) ws.send(Buffer.concat(s.chunks), { binary: true });
      return s;
    })();

    let lastPong = Date.now();
    ws.on("pong", () => (lastPong = Date.now()));
    const ping = setInterval(() => {
      if (Date.now() - lastPong > 60_000) return ws.terminate();
      try {
        ws.ping();
      } catch {
        /* ignore */
      }
    }, 20_000);

    ws.on("message", (data, isBinary) => {
      void ready.then((s) => {
        if (!s || s.exited) return;
        if (isBinary) {
          s.proc.write(data as Buffer);
          return;
        }
        let m: { t?: string; d?: unknown; c?: unknown; r?: unknown };
        try {
          m = JSON.parse(data.toString());
        } catch {
          return;
        }
        if (m.t === "i" && typeof m.d === "string") s.proc.write(m.d);
        else if (m.t === "r") {
          try {
            s.proc.resize(clamp(m.c, 10, 500, 80), clamp(m.r, 2, 200, 24));
          } catch {
            /* ignore */
          }
        } else if (m.t === "kill") {
          try {
            hardKill(s.proc);
          } catch {
            /* ignore */
          }
        }
      });
    });

    // 登录失效（密码到期 / 被强制下线 / 改了密码）：立即结束终端进程并断开
    const authTimer = setInterval(() => {
      void desktopAuthedHeader(req.headers.cookie, url.searchParams.get("access")).then((ok) => {
        if (ok) return;
        clearInterval(authTimer);
        void ready.then((s) => {
          if (s && !s.exited) {
            try {
              hardKill(s.proc);
            } catch {
              /* ignore */
            }
          }
        });
        try {
          ws.close(4001, "auth");
        } catch {
          /* ignore */
        }
      });
    }, 5000);

    const onGone = () => {
      clearInterval(ping);
      clearInterval(authTimer);
      void ready.then((s) => {
        if (!s) return;
        s.clients.delete(ws);
        if (s.clients.size === 0 && !s.exited) scheduleKill(s);
      });
    };
    ws.on("close", onGone);
    ws.on("error", onGone);
  });
}
