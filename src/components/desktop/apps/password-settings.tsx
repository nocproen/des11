"use client";

import { useEffect, useState, type FormEvent } from "react";

type ExpiryInfo = {
  expiresAt: number | null;
  setAt: number | null;
  serverNow: number;
  offset: number;
};

type Notice = { type: "success" | "error"; text: string } | null;

function dateLabel(value: number) {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(value);
}

function remainingLabel(milliseconds: number) {
  const minutes = Math.max(0, Math.ceil(milliseconds / 60_000));
  const days = Math.floor(minutes / 1_440);
  const hours = Math.floor((minutes % 1_440) / 60);
  const mins = minutes % 60;
  if (days) return `${days} 天 ${hours} 小时`;
  if (hours) return `${hours} 小时 ${mins} 分钟`;
  return `${mins} 分钟`;
}

const fieldClass =
  "mt-1.5 w-full rounded-lg border border-white/15 bg-slate-950/60 px-3 py-2.5 text-sm text-white outline-none placeholder:text-slate-500 focus:border-sky-400 focus:ring-1 focus:ring-sky-400/30";

export function PasswordSettings() {
  const [expiry, setExpiry] = useState<ExpiryInfo | null>(null);
  const [statusError, setStatusError] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  useEffect(() => {
    let active = true;
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    fetch("/api/auth/password", { cache: "no-store" })
      .then(async (response) => {
        if (response.status === 401) {
          window.location.replace("/");
          return;
        }
        if (!response.ok) throw new Error("无法读取密码有效期，请稍后重试");
        const data = (await response.json()) as Omit<ExpiryInfo, "offset">;
        if (active) setExpiry({ ...data, offset: data.serverNow - Date.now() });
      })
      .catch((error: unknown) => {
        if (active) setStatusError(error instanceof Error ? error.message : "无法读取密码有效期");
      });
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    if (newPassword !== confirmPassword) {
      setNotice({ type: "error", text: "两次输入的新密码不一致" });
      return;
    }
    if (newPassword === currentPassword) {
      setNotice({ type: "error", text: "新密码不能与当前密码相同" });
      return;
    }

    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch("/api/auth/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword, confirmPassword }),
        cache: "no-store",
      });
      const data = (await response.json()) as { error?: string; message?: string };
      if (response.ok) {
        setCurrentPassword("");
        setNewPassword("");
        setConfirmPassword("");
        setNotice({ type: "success", text: data.message ?? "密码已更新，请使用新密码重新登录" });
        window.setTimeout(() => window.location.replace("/"), 1300);
      } else if (response.status === 401) {
        window.location.replace("/");
      } else {
        setNotice({ type: "error", text: data.error ?? "修改失败，请重试" });
      }
    } catch {
      setNotice({ type: "error", text: "网络连接失败，请稍后重试" });
    } finally {
      setBusy(false);
    }
  }

  const remaining = expiry?.expiresAt === null ? null : expiry?.expiresAt ? expiry.expiresAt - (now + expiry.offset) : null;

  return (
    <div className="mx-auto max-w-xl space-y-5 pb-8">
      <div className="flex items-start gap-3">
        <div className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-sky-500/15 text-2xl">🔐</div>
        <div>
          <h3 className="text-base font-semibold text-white">修改桌面访问密码</h3>
          <p className="mt-1 text-xs leading-5 text-slate-400">使用当前密码验证身份后，可以设置自己想要的新密码。</p>
        </div>
      </div>

      <div className="rounded-xl border border-sky-400/20 bg-sky-400/5 p-4">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-slate-300">密码到期时间</span>
          <span className="rounded-full border border-white/10 px-2 py-0.5 text-[11px] text-slate-400">只读 · 由管理员设置</span>
        </div>
        {statusError ? (
          <p className="mt-3 text-xs text-rose-300" role="alert">{statusError}</p>
        ) : !expiry ? (
          <p className="mt-3 text-sm text-slate-400">正在读取有效期…</p>
        ) : (
          <>
            <p className="mt-3 text-lg font-semibold tabular-nums text-white">
              {expiry.expiresAt === null ? "永久有效" : dateLabel(expiry.expiresAt)}
            </p>
            {remaining !== null && (
              <p className={`mt-1 text-xs ${remaining <= 0 ? "text-rose-300" : "text-sky-200"}`}>
                {remaining <= 0 ? "已到期，请联系管理员" : `剩余约 ${remainingLabel(remaining)}`}
              </p>
            )}
          </>
        )}
        <p className="mt-3 border-t border-white/10 pt-3 text-xs leading-5 text-slate-400">
          更换密码不会重新计时，也不会延长或缩短有效期。前台无法修改此时间。
        </p>
      </div>

      <form className="space-y-4 rounded-xl border border-white/10 bg-black/20 p-4" onSubmit={submit}>
        <label className="block text-xs font-medium text-slate-300">
          当前密码
          <input
            className={fieldClass}
            type={showPassword ? "text" : "password"}
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
            autoComplete="current-password"
            placeholder="输入正在使用的桌面密码"
            maxLength={256}
            required
          />
        </label>
        <label className="block text-xs font-medium text-slate-300">
          新密码
          <input
            className={fieldClass}
            type={showPassword ? "text" : "password"}
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
            autoComplete="new-password"
            placeholder="自定义新密码（6–128 位）"
            minLength={6}
            maxLength={128}
            required
          />
        </label>
        <label className="block text-xs font-medium text-slate-300">
          确认新密码
          <input
            className={fieldClass}
            type={showPassword ? "text" : "password"}
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
            autoComplete="new-password"
            placeholder="再次输入新密码"
            minLength={6}
            maxLength={128}
            required
          />
        </label>
        <label className="flex w-fit cursor-pointer items-center gap-2 text-xs text-slate-400">
          <input
            type="checkbox"
            checked={showPassword}
            onChange={(event) => setShowPassword(event.target.checked)}
            className="accent-sky-400"
          />
          显示输入的密码
        </label>
        {notice && (
          <p
            role="alert"
            className={`rounded-lg px-3 py-2 text-xs ${
              notice.type === "success" ? "bg-emerald-500/15 text-emerald-300" : "bg-rose-500/15 text-rose-300"
            }`}
          >
            {notice.text}
          </p>
        )}
        <button
          type="submit"
          disabled={busy || !expiry || (remaining !== null && remaining <= 0)}
          className="w-full rounded-lg bg-sky-500 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-sky-400 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? "正在修改…" : "保存新密码"}
        </button>
        <p className="text-xs leading-5 text-slate-500">保存后所有已登录的桌面会话将失效，当前设备需要使用新密码重新登录。</p>
      </form>
    </div>
  );
}
