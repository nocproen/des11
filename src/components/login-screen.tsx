"use client";

import { useEffect, useRef, useState } from "react";

export function LoginScreen({ lock, onAuthenticated, message }: {
  lock: "ready" | "unset" | "expired";
  onAuthenticated: (sessionId: string) => void;
  message?: string;
}) {
  const passwordSet = lock === "ready";
  const [pw, setPw] = useState("");
  const [show, setShow] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState<Date | null>(null);
  const [wait, setWait] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => input.current?.focus(), []);
  useEffect(() => {
    if (wait <= 0) return;
    const t = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(t);
  }, [wait]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || !pw || wait > 0) return;
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: pw }),
        cache: "no-store",
      });
      const d = (await r.json().catch(() => ({}))) as { error?: string; retryAfter?: number; sessionId?: string };
      if (r.ok && d.sessionId) {
        setPw("");
        onAuthenticated(d.sessionId);
        return;
      }
      setError(d.error ?? "登录失败");
      if (d.retryAfter) setWait(d.retryAfter);
      setPw("");
      input.current?.focus();
    } catch {
      setError("网络错误，请稍后重试");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="fixed inset-0 overflow-y-auto text-white" style={{ background: "url(/wallpapers/1.jpg) center / cover no-repeat, #0f172a" }}>
      <div className="grid min-h-full place-items-center bg-black/45 px-4 py-10 backdrop-blur-md">
        <div className="w-full max-w-sm text-center">
          <div className="mb-10 select-none">
            <div className="text-7xl font-extralight tabular-nums tracking-tight">
              {now ? now.toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit" }) : "--:--"}
            </div>
            <div className="mt-2 text-sm text-white/70">
              {now ? now.toLocaleDateString("zh-CN", { month: "long", day: "numeric", weekday: "long" }) : "\u00a0"}
            </div>
          </div>

          <form onSubmit={submit} className="rounded-3xl border border-white/15 bg-slate-900/60 p-6 text-left shadow-2xl backdrop-blur-xl">
            <div className="mb-5 flex flex-col items-center gap-2">
              <span className="grid h-16 w-16 place-items-center rounded-full bg-gradient-to-br from-sky-400 to-indigo-500 text-3xl shadow-lg">🔒</span>
              <h1 className="text-lg font-semibold">WebDesktop</h1>
              <p className="text-xs text-slate-400">
                {lock === "ready" ? "输入密码，接管并同步这台桌面" : lock === "expired" ? "访问密码已过期" : "桌面尚未开放"}
              </p>
            </div>

            {passwordSet ? (
              <>
                <div className="relative">
                  <input ref={input} type={show ? "text" : "password"} value={pw} onChange={(e) => setPw(e.target.value)}
                    placeholder="访问密码" autoComplete="current-password" maxLength={256} disabled={wait > 0}
                    className="w-full rounded-xl border border-white/15 bg-black/30 px-4 py-3 pr-12 text-base outline-none placeholder:text-slate-500 focus:border-sky-400 disabled:opacity-50" />
                  <button type="button" onClick={() => setShow((v) => !v)} aria-label={show ? "隐藏密码" : "显示密码"}
                    className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg px-2 py-1 text-sm text-slate-400 hover:text-white">{show ? "🙈" : "👁️"}</button>
                </div>
                {(message || error) && <p role="alert" className="mt-3 rounded-lg bg-red-500/15 px-3 py-2 text-xs leading-relaxed text-red-200">{error || message}</p>}
                <button type="submit" disabled={busy || !pw || wait > 0}
                  className="mt-4 w-full rounded-xl bg-sky-500 py-3 text-sm font-semibold text-white transition hover:bg-sky-400 disabled:opacity-40">
                  {busy ? "验证中…" : wait > 0 ? `请 ${wait} 秒后重试` : "解锁并接管桌面"}
                </button>
                <p className="mt-3 text-center text-xs leading-5 text-slate-400">
                  每次重新打开或刷新网页均需输入密码。新登录会立即让之前的使用者下线；桌面窗口与文件同步保留。
                </p>
              </>
            ) : (
              <p className="rounded-xl bg-amber-500/10 px-4 py-3 text-center text-sm text-amber-200">
                {lock === "expired" ? "访问密码已经过期，请联系管理员重新设置或续期。" : "管理员还没有设置访问密码，请联系管理员。"}
              </p>
            )}
          </form>
        </div>
      </div>
    </main>
  );
}
