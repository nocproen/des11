"use client";

import { useEffect, useRef, useState } from "react";
import { useWm, type Win } from "../wm-store";

type Status = {
  state: "preparing" | "starting" | "running" | "exited" | "failed";
  note: string;
  log: string;
  exitCode: number | null;
  name: string;
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
const Q_HIGH = 7;
const Q_LOW = 1;
const Q_IDLE_MS = 500;

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
    const r = await fetch(`/api/gui/${sid}`, { cache: "no-store", signal: AbortSignal.timeout(10_000) });
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
  const rfbRef = useRef<Rfb | null>(null);
  const sidRef = useRef<string | null>(null);
  const [phase, setPhase] = useState<"preparing" | "running" | "ended">("preparing");
  const [status, setStatus] = useState<Status | null>(null);
  const [err, setErr] = useState("");
  const [runKey, setRunKey] = useState(0);
  const [reconnecting, setReconnecting] = useState(false);
  const [ime, setIme] = useState(false);
  const [imeText, setImeText] = useState("");
  const imeRef = useRef<HTMLInputElement>(null);
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

    const end = (message: string, st?: Status) => {
      if (dead) return;
      if (st) setStatus(st);
      setErr(message);
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
      host.innerHTML = "";
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const r = new RFB(host, `${proto}://${location.host}/api/gui/ws?sid=${sid}`, { shared: true });
      rfb = r;
      rfbRef.current = r;
      r.scaleViewport = false;
      r.resizeSession = true; // 窗口大小变化时，让虚拟显示器跟着变
      r.showDotCursor = false;
      r.background = "#0b1120";
      r.compressionLevel = 2;
      setQuality(r, forcedQ ?? Q_HIGH);
      r.addEventListener("connect", () => {
        everConnected = true;
        failedConnects = 0;
        setReconnecting(false);
        setPhase("running");
        r.focus();
      });
      r.addEventListener("clipboard", (e) => {
        const text = (e.detail as { text?: string } | undefined)?.text;
        if (text) navigator.clipboard?.writeText(text).catch(() => {});
      });
      r.addEventListener("disconnect", async () => {
        if (dead) return;
        if (rfbRef.current === r) rfbRef.current = null;
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

    // 滚动时临时降画质，停下后恢复
    const onWheel = () => {
      const r = rfb;
      if (!r || forcedQ !== null) return;
      setQuality(r, Q_LOW);
      clearTimeout(qTimer);
      qTimer = setTimeout(() => rfb && setQuality(rfb, Q_HIGH), Q_IDLE_MS);
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

    // Ctrl+V：先把本机剪贴板（图片或文字）同步给远程，再发送粘贴按键
    const onKey = (ev: KeyboardEvent) => {
      const r = rfb;
      if (!r || !(ev.ctrlKey || ev.metaKey) || ev.shiftKey || ev.altKey || ev.key.toLowerCase() !== "v") return;
      if (!navigator.clipboard?.readText) return;
      ev.preventDefault();
      ev.stopPropagation();
      const press = () => {
        r.sendKey(0xffe3, "ControlLeft", true);
        r.sendKey(0x76, "KeyV", true);
        r.sendKey(0x76, "KeyV", false);
        r.sendKey(0xffe3, "ControlLeft", false);
      };
      void pasteImage().then((done) => {
        if (done) return setTimeout(press, 50);
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

    // 注意：刷新 / 关闭某一个浏览器页面不会结束应用。桌面窗口是多个浏览器共享的，其他浏览器可能还在看同一个画面；
    // 应用只在窗口被关闭时结束（见下面的清理函数），空闲一段时间没人连接后服务器会自动回收。

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
              ? { key: winId, preset: "browser", url: init.path, w: Math.round(box.width) || 1024, h: Math.round(box.height) || 640 }
              : {
                  key: winId, // 窗口 id：同一个窗口在所有浏览器里共享同一个应用会话
                  exec: cmd,
                  desktopFile,
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
        if (dead) {
          // This view detached while the shared session was starting.
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
      host.removeEventListener("keydown", onKey, true);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("focus", onOnline);
      document.removeEventListener("visibilitychange", onVisible);
      rfb?.disconnect();
      rfbRef.current = null;
      sidRef.current = null;
      // The server closes sessions only after a shared window-close commit.
      host.innerHTML = "";
    };
  }, [runKey, winId, cmd, desktopFile, isBrowser]);

  const sendIme = () => {
    const r = rfbRef.current;
    if (!r || !imeText) return;
    typeText(r, imeText);
    setImeText("");
    imeRef.current?.focus();
  };

  return (
    <div className="relative flex h-full flex-col bg-[#0b1120]">
      <div className="relative min-h-0 flex-1">
        <div ref={hostRef} className="absolute inset-0" />

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

        {reconnecting && phase === "running" && (
          <div className="pointer-events-none absolute left-1/2 top-3 z-20 -translate-x-1/2 rounded-full bg-black/70 px-4 py-1.5 text-xs text-slate-200 shadow-lg backdrop-blur">
            连接中断，正在重新连接…
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
