"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Status = {
  running: boolean;
  localCommit: string;
  remoteCommit: string;
  behind: number;
  updateAvailable: boolean;
  lastCheck: number | null;
  lastResult: "ok" | "error" | null;
  message: string;
  buildId: string;
  autoUpdate: boolean;
  restartOnUpdate: boolean;
  intervalMin: number;
  remoteUrl: string;
  log: string;
};

const short = (s: string) => (s ? s.slice(0, 8) : "--------");
const time = (t: number | null) =>
  t ? new Date(t).toLocaleTimeString("zh-CN", { hour12: false }) : "—";

// 右上角的版本徽标：只有后台管理员可见。点击展开 = 版本信息 + 一键更新 + 更新日志。
export default function UpdatePanel() {
  const [status, setStatus] = useState<Status | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const logRef = useRef<HTMLPreElement | null>(null);

  const load = useCallback(async (check = false) => {
    try {
      const res = await fetch(`/api/deploy?check=${check ? "1" : "0"}`, { cache: "no-store" });
      if (res.status === 401 || res.status === 404) {
        setStatus(null);
        return;
      }
      if (!res.ok) return;
      setStatus((await res.json()) as Status);
      setError("");
    } catch {
      /* 网络抖动时保留上一次状态 */
    }
  }, []);

  useEffect(() => {
    void load(true);
    const poll = setInterval(() => void load(false), 30_000);
    return () => clearInterval(poll);
  }, [load]);

  useEffect(() => {
    if (status?.running) {
      const fast = setInterval(() => void load(false), 2000);
      return () => clearInterval(fast);
    }
  }, [status?.running, load]);

  useEffect(() => {
    if (open && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [status?.log, open]);

  if (!status) return null;

  const act = async (action: "check" | "apply") => {
    setBusy(true);
    try {
      const res = await fetch("/api/deploy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const data = (await res.json()) as Status & { error?: string };
      if (!res.ok) setError(data.error || "操作失败");
      else {
        setStatus(data);
        if (action === "apply") setOpen(true);
      }
    } catch {
      setError("网络错误，请重试");
    } finally {
      setBusy(false);
    }
  };

  const dot = status.running
    ? "bg-sky-400 animate-pulse"
    : status.updateAvailable
      ? "bg-amber-400"
      : status.lastResult === "error"
        ? "bg-rose-400"
        : "bg-emerald-400";

  return (
    <div className="pointer-events-none fixed right-3 top-3 z-[9999] flex flex-col items-end gap-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="pointer-events-auto flex items-center gap-2 rounded-full border border-white/10 bg-slate-900/80 px-3 py-1.5 text-[11px] text-slate-200 shadow-[0_8px_24px_rgba(0,0,0,0.45)] backdrop-blur-md transition hover:border-white/25 hover:bg-slate-800/90"
      >
        <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
        <span className="font-medium tracking-wide">
          {status.running ? "更新中" : status.updateAvailable ? `有新版本 · ${status.behind}` : "服务版本"}
        </span>
        <span className="font-mono text-[10px] text-slate-400 tabular-nums">{short(status.localCommit)}</span>
      </button>

      {open && (
        <div className="pointer-events-auto w-[20rem] overflow-hidden rounded-2xl border border-white/10 bg-slate-900/95 shadow-[0_24px_60px_rgba(0,0,0,0.55)] backdrop-blur-xl">
          <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
            <div>
              <p className="text-[13px] font-semibold text-slate-100">服务更新</p>
              <p className="text-[11px] text-slate-400">源码有变化就自动拉取并重建</p>
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded-md px-2 py-1 text-slate-400 transition hover:bg-white/10 hover:text-slate-100"
              aria-label="关闭"
            >
              ✕
            </button>
          </div>

          <dl className="grid grid-cols-[4.5rem_1fr] gap-x-3 gap-y-1.5 px-4 py-3 text-[11px]">
            <dt className="text-slate-500">当前版本</dt>
            <dd className="font-mono text-slate-200 tabular-nums">{short(status.localCommit)}</dd>
            <dt className="text-slate-500">上游版本</dt>
            <dd className="font-mono text-slate-200 tabular-nums">{short(status.remoteCommit)}</dd>
            <dt className="text-slate-500">构建编号</dt>
            <dd className="font-mono text-slate-400 tabular-nums">{status.buildId || "—"}</dd>
            <dt className="text-slate-500">自动更新</dt>
            <dd className="text-slate-300">
              {status.autoUpdate ? `已开启 · 每 ${status.intervalMin} 分钟巡检` : "已关闭"}
            </dd>
            <dt className="text-slate-500">最近检查</dt>
            <dd className="text-slate-300 tabular-nums">{time(status.lastCheck)}</dd>
          </dl>

          <div className="mx-4 rounded-lg border border-white/10 bg-slate-950/70 px-3 py-2 text-[11px] text-slate-300">
            {status.running ? "正在拉取源码并重新构建，请勿关闭页面…" : status.message || "状态正常"}
          </div>

          {error && <p className="px-4 pt-2 text-[11px] text-rose-300">{error}</p>}

          <div className="flex gap-2 px-4 py-3">
            <button
              type="button"
              disabled={busy || status.running}
              onClick={() => void act("check")}
              className="flex-1 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-[12px] text-slate-200 transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
            >
              检查更新
            </button>
            <button
              type="button"
              disabled={busy || status.running || !status.updateAvailable}
              onClick={() => void act("apply")}
              className="flex-1 rounded-lg bg-sky-500 px-3 py-2 text-[12px] font-medium text-white transition hover:bg-sky-400 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
            >
              {status.running ? "更新中…" : "立即更新"}
            </button>
          </div>

          {status.log && (
            <pre
              ref={logRef}
              className="max-h-48 overflow-auto whitespace-pre-wrap break-all border-t border-white/10 bg-slate-950/80 px-4 py-3 font-mono text-[10px] leading-relaxed text-slate-400"
            >
              {status.log.slice(-2500)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
