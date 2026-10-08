"use client";

import { useCallback, useEffect, useState } from "react";

type State = {
  username: string;
  mustChange: boolean;
  desktop: { set: boolean; setAt: number | null; expiresAt: number | null; expired: boolean };
  desktopPassword: string | null;
  serverNow: number;
};
type Msg = { kind: "ok" | "err"; text: string } | null;

function randomPassword() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(14));
  return Array.from(bytes, (b) => chars[b % chars.length]).join("");
}

const card = "rounded-2xl border border-white/10 bg-slate-900/70 p-5 shadow-xl";
const input =
  "w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none placeholder:text-slate-500 focus:border-sky-400";
const btn = "rounded-lg px-4 py-2 text-sm font-medium transition disabled:opacity-40";

export function AdminApp({ slug }: { slug: string }) {
  const api = useCallback(
    async (action: string, body?: object) => {
      const r = await fetch(`/api/ops/${slug}/${action}`, {
        method: body ? "POST" : "GET",
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
        cache: "no-store",
      });
      const d = (await r.json().catch(() => ({}))) as Record<string, unknown> & { error?: string };
      return { ok: r.ok, status: r.status, data: d };
    },
    [slug],
  );

  const [state, setState] = useState<State | null>(null);
  const [phase, setPhase] = useState<"loading" | "login" | "panel">("loading");

  const load = useCallback(async () => {
    const r = await api("state");
    if (r.ok) {
      const d = r.data as unknown as State;
      setState({ ...d, serverNow: d.serverNow - Date.now() }); // serverNow 存为「服务器时间 - 本机时间」的偏移，倒计时不受本机时钟影响
      setPhase("panel");
    } else setPhase("login");
  }, [api]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  return (
    <main className="fixed inset-0 overflow-y-auto bg-slate-950 text-slate-100">
      <div className="mx-auto flex min-h-full max-w-2xl flex-col px-4 py-10">
        <header className="mb-8 flex items-center gap-3">
          <span className="grid h-11 w-11 place-items-center rounded-xl bg-gradient-to-br from-violet-500 to-sky-500 text-xl">
            🛡️
          </span>
          <div>
            <h1 className="text-lg font-semibold">WebDesktop 管理后台</h1>
            <p className="text-xs text-slate-500">设置桌面访问密码与管理员账号</p>
          </div>
          {phase === "panel" && state && (
            <button
              onClick={async () => {
                await api("logout", {});
                setState(null);
                setPhase("login");
              }}
              className={`${btn} ml-auto bg-white/10 hover:bg-white/20`}
            >
              退出登录
            </button>
          )}
        </header>

        {phase === "loading" && <div className="py-20 text-center text-sm text-slate-500">加载中…</div>}
        {phase === "login" && <Login api={api} onDone={load} />}
        {phase === "panel" && state && <Panel state={state} api={api} reload={load} />}
      </div>
    </main>
  );
}

type Api = (action: string, body?: object) => Promise<{ ok: boolean; status: number; data: Record<string, unknown> & { error?: string } }>;

function Login({ api, onDone }: { api: Api; onDone: () => void }) {
  const [u, setU] = useState("");
  const [p, setP] = useState("");
  const [msg, setMsg] = useState<Msg>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className={`${card} mx-auto w-full max-w-sm space-y-3`}
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setMsg(null);
        const r = await api("login", { username: u, password: p });
        setBusy(false);
        if (r.ok) onDone();
        else {
          setMsg({ kind: "err", text: r.data.error ?? "登录失败" });
          setP("");
        }
      }}
    >
      <h2 className="text-base font-semibold">管理员登录</h2>
      <input
        className={input}
        value={u}
        onChange={(e) => setU(e.target.value)}
        placeholder="账号"
        autoComplete="username"
        autoFocus
        maxLength={64}
      />
      <input
        className={input}
        type="password"
        value={p}
        onChange={(e) => setP(e.target.value)}
        placeholder="密码"
        autoComplete="current-password"
        maxLength={256}
      />
      <Notice msg={msg} />
      <button disabled={busy || !u || !p} className={`${btn} w-full bg-sky-500 text-white hover:bg-sky-400`}>
        {busy ? "登录中…" : "登录"}
      </button>
    </form>
  );
}

function Notice({ msg }: { msg: Msg }) {
  if (!msg) return null;
  return (
    <p
      role="alert"
      className={`rounded-lg px-3 py-2 text-xs ${
        msg.kind === "ok" ? "bg-emerald-500/15 text-emerald-300" : "bg-red-500/15 text-red-300"
      }`}
    >
      {msg.text}
    </p>
  );
}

function Panel({ state, api, reload }: { state: State; api: Api; reload: () => void }) {
  return (
    <div className="space-y-5">
      {state.mustChange && (
        <div className="rounded-2xl border border-amber-400/30 bg-amber-500/10 p-4 text-sm text-amber-200">
          ⚠️ 你正在使用默认的后台密码。请先修改账号密码，修改完成后才能使用其他功能。
        </div>
      )}
      {!state.mustChange && <DesktopPassword state={state} api={api} reload={reload} />}
      <Account state={state} api={api} reload={reload} />
    </div>
  );
}

const PRESETS: { label: string; minutes: number | null }[] = [
  { label: "1 小时", minutes: 60 },
  { label: "8 小时", minutes: 480 },
  { label: "1 天", minutes: 1440 },
  { label: "7 天", minutes: 7 * 1440 },
  { label: "30 天", minutes: 30 * 1440 },
  { label: "90 天", minutes: 90 * 1440 },
  { label: "永久有效", minutes: null },
];
const UNITS = [
  { label: "分钟", mul: 1 },
  { label: "小时", mul: 60 },
  { label: "天", mul: 1440 },
];

type Validity = { minutes: number | null; valid: boolean };

/** 有效期选择器：常用预设 + 自定义（数值 + 单位） */
function ValidityPicker({ value, onChange }: { value: Validity; onChange: (v: Validity) => void }) {
  const [custom, setCustom] = useState(false);
  const [num, setNum] = useState("");
  const [unit, setUnit] = useState(2);
  const apply = (n: string, u: number) => {
    const v = Number(n);
    const m = Math.round(v * UNITS[u].mul);
    onChange({ minutes: m, valid: Number.isFinite(v) && v > 0 && m >= 1 && m <= 3650 * 1440 });
  };
  return (
    <div>
      <div className="flex flex-wrap gap-1.5">
        {PRESETS.map((p) => {
          const on = !custom && value.minutes === p.minutes;
          return (
            <button
              type="button"
              key={p.label}
              onClick={() => {
                setCustom(false);
                onChange({ minutes: p.minutes, valid: true });
              }}
              className={`rounded-full border px-3 py-1 text-xs transition ${
                on ? "border-sky-400 bg-sky-500/20 text-sky-200" : "border-white/10 text-slate-300 hover:bg-white/10"
              }`}
            >
              {p.label}
            </button>
          );
        })}
        <button
          type="button"
          onClick={() => {
            setCustom(true);
            apply(num, unit);
          }}
          className={`rounded-full border px-3 py-1 text-xs transition ${
            custom ? "border-sky-400 bg-sky-500/20 text-sky-200" : "border-white/10 text-slate-300 hover:bg-white/10"
          }`}
        >
          自定义
        </button>
      </div>
      {custom && (
        <div className="mt-2 flex items-center gap-2">
          <input
            className={`${input} w-28`}
            inputMode="decimal"
            value={num}
            onChange={(e) => {
              setNum(e.target.value);
              apply(e.target.value, unit);
            }}
            placeholder="数值"
          />
          <select
            className={`${input} w-24`}
            value={unit}
            onChange={(e) => {
              setUnit(Number(e.target.value));
              apply(num, Number(e.target.value));
            }}
          >
            {UNITS.map((u, i) => (
              <option key={u.label} value={i}>
                {u.label}
              </option>
            ))}
          </select>
          {!value.valid && num !== "" && <span className="text-xs text-red-300">范围：1 分钟 ~ 10 年</span>}
        </div>
      )}
    </div>
  );
}

const pad = (n: number) => String(n).padStart(2, "0");
function fmtDate(ms: number) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function fmtRemain(ms: number) {
  const t = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(t / 86400);
  const h = Math.floor((t % 86400) / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = t % 60;
  if (d > 0) return `${d} 天 ${h} 小时 ${m} 分`;
  if (h > 0) return `${h} 小时 ${m} 分 ${sec} 秒`;
  return `${m} 分 ${sec} 秒`;
}

function DesktopPassword({ state, api, reload }: { state: State; api: Api; reload: () => void }) {
  const { desktop } = state;
  const [pw, setPw] = useState("");
  const [showNew, setShowNew] = useState(false);
  const [reveal, setReveal] = useState(false);
  const [validity, setValidity] = useState<Validity>({ minutes: null, valid: true });
  const [renew, setRenew] = useState<Validity>({ minutes: 7 * 1440, valid: true });
  const [msg, setMsg] = useState<Msg>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  // 倒计时：每秒刷新；到期瞬间重新拉取状态
  const offset = state.serverNow;
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const serverTime = now + offset;
  const expired = desktop.set && desktop.expiresAt !== null && desktop.expiresAt <= serverTime;
  useEffect(() => {
    if (desktop.set && desktop.expiresAt && !desktop.expired && desktop.expiresAt <= serverTime) reload();
  }, [desktop.set, desktop.expiresAt, desktop.expired, serverTime, reload]);

  const run = async (action: string, body: object, okText: string, confirmText?: string) => {
    if (confirmText && !window.confirm(confirmText)) return false;
    setBusy(true);
    setMsg(null);
    const r = await api(action, body);
    setBusy(false);
    if (r.ok) {
      setMsg({ kind: "ok", text: okText });
      reload();
      return true;
    }
    setMsg({ kind: "err", text: r.data.error ?? "操作失败" });
    return false;
  };

  const copy = async () => {
    if (!state.desktopPassword) return;
    try {
      await navigator.clipboard.writeText(state.desktopPassword);
      setMsg({ kind: "ok", text: "已复制当前桌面密码" });
    } catch {
      setReveal(true);
      setMsg({ kind: "err", text: "浏览器不允许自动复制，请手动选中复制" });
    }
  };

  const badge = !desktop.set
    ? { text: "未设置 · 桌面已锁定", cls: "bg-red-500/20 text-red-300" }
    : expired
      ? { text: "已过期 · 桌面已锁定", cls: "bg-red-500/20 text-red-300" }
      : { text: "生效中", cls: "bg-emerald-500/20 text-emerald-300" };

  return (
    <section className={card}>
      <div className="mb-4 flex items-center gap-2">
        <h2 className="text-base font-semibold">桌面访问密码</h2>
        <span className={`rounded-full px-2.5 py-0.5 text-xs ${badge.cls}`}>{badge.text}</span>
      </div>

      {desktop.set && (
        <div className="mb-5 rounded-xl border border-white/10 bg-black/25 p-4">
          <div className="text-xs text-slate-400">当前桌面密码</div>
          <div className="mt-1.5 flex items-center gap-2">
            <code className="min-w-0 flex-1 break-all rounded-lg bg-black/40 px-3 py-2 font-mono text-base tracking-wide">
              {state.desktopPassword === null
                ? "（旧密码未记录，请重新设置一次）"
                : reveal
                  ? state.desktopPassword
                  : "•".repeat(Math.min(state.desktopPassword.length, 16))}
            </code>
            {state.desktopPassword !== null && (
              <>
                <button
                  type="button"
                  onClick={() => setReveal((v) => !v)}
                  className={`${btn} shrink-0 bg-white/10 hover:bg-white/20`}
                >
                  {reveal ? "隐藏" : "显示"}
                </button>
                <button type="button" onClick={copy} className={`${btn} shrink-0 bg-white/10 hover:bg-white/20`}>
                  复制
                </button>
              </>
            )}
          </div>
          <dl className="mt-3 grid grid-cols-[5.5rem_1fr] gap-y-1.5 text-sm">
            <dt className="text-slate-500">设置时间</dt>
            <dd>{desktop.setAt ? fmtDate(desktop.setAt) : "—"}</dd>
            <dt className="text-slate-500">有效期</dt>
            <dd>
              {desktop.expiresAt === null ? (
                <span className="text-emerald-300">永久有效</span>
              ) : (
                <>
                  至 {fmtDate(desktop.expiresAt)}{" "}
                  {expired ? (
                    <span className="ml-1 rounded bg-red-500/20 px-1.5 py-0.5 text-xs text-red-300">已过期</span>
                  ) : (
                    <span className="ml-1 rounded bg-sky-500/20 px-1.5 py-0.5 text-xs tabular-nums text-sky-200">
                      剩余 {fmtRemain(desktop.expiresAt - serverTime)}
                    </span>
                  )}
                </>
              )}
            </dd>
          </dl>
        </div>
      )}

      <form
        className="space-y-3"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!validity.valid) return;
          const ok = await run(
            "desktop-password",
            { password: pw, expiresInMinutes: validity.minutes },
            desktop.set ? "桌面密码已更新，所有已登录的桌面已下线" : "桌面密码已设置，现在可以用它进入桌面",
          );
          if (ok) {
            setPw("");
            setShowNew(false);
          }
        }}
      >
        <h3 className="text-sm font-medium text-slate-300">{desktop.set ? "设置新的桌面密码" : "设置桌面密码"}</h3>
        <div className="flex gap-2">
          <input
            className={`${input} font-mono`}
            type={showNew ? "text" : "password"}
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            placeholder="至少 6 位"
            autoComplete="new-password"
            maxLength={128}
          />
          <button
            type="button"
            onClick={() => setShowNew((v) => !v)}
            className={`${btn} shrink-0 bg-white/10 hover:bg-white/20`}
            aria-label="显示或隐藏"
          >
            {showNew ? "🙈" : "👁️"}
          </button>
          <button
            type="button"
            onClick={() => {
              setPw(randomPassword());
              setShowNew(true);
            }}
            className={`${btn} shrink-0 bg-white/10 hover:bg-white/20`}
          >
            随机生成
          </button>
        </div>
        <div>
          <div className="mb-1.5 text-xs text-slate-400">这个密码能使用多久</div>
          <ValidityPicker value={validity} onChange={setValidity} />
        </div>
        <button disabled={busy || pw.length < 6 || !validity.valid} className={`${btn} bg-sky-500 text-white hover:bg-sky-400`}>
          {desktop.set ? "更新密码并重新计时" : "设置桌面密码"}
        </button>
        <p className="text-xs text-slate-500">
          更新密码会让所有已登录的桌面立即下线。有效期从点击按钮的这一刻开始计算，到期后桌面自动锁定，已登录的人也会被踢下线。
        </p>
      </form>

      {desktop.set && (
        <div className="mt-5 space-y-3 border-t border-white/10 pt-5">
          <h3 className="text-sm font-medium text-slate-300">修改有效期（密码不变）</h3>
          <ValidityPicker value={renew} onChange={setRenew} />
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy || !renew.valid}
              onClick={() =>
                void run(
                  "desktop-expiry",
                  { expiresInMinutes: renew.minutes },
                  renew.minutes === null ? "已改为永久有效" : "有效期已更新，从现在开始重新计时",
                )
              }
              className={`${btn} bg-white/10 hover:bg-white/20`}
            >
              {expired ? "续期并恢复桌面" : "更新有效期（从现在起算）"}
            </button>
          </div>
        </div>
      )}

      <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-white/10 pt-5">
        <Notice msg={msg} />
        {desktop.set && (
          <>
            <button
              type="button"
              disabled={busy}
              onClick={() => void run("kick", {}, "已让所有桌面下线，需要重新输入密码", "让所有已登录的桌面立即下线？")}
              className={`${btn} bg-white/10 hover:bg-white/20`}
            >
              强制所有人下线
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void run(
                  "desktop-password",
                  { clear: true },
                  "已清除桌面密码，桌面现已锁定，任何人都无法进入",
                  "清除后桌面将被锁定，直到再次设置密码。确定吗？",
                )
              }
              className={`${btn} ml-auto bg-red-500/20 text-red-300 hover:bg-red-500/30`}
            >
              清除密码（锁定桌面）
            </button>
          </>
        )}
      </div>
    </section>
  );
}

function Account({ state, api, reload }: { state: State; api: Api; reload: () => void }) {
  const [cur, setCur] = useState("");
  const [name, setName] = useState(state.username);
  const [np, setNp] = useState("");
  const [np2, setNp2] = useState("");
  const [msg, setMsg] = useState<Msg>(null);
  const [busy, setBusy] = useState(false);

  return (
    <section className={card}>
      <h2 className="mb-4 text-base font-semibold">管理员账号</h2>
      <form
        className="space-y-3"
        onSubmit={async (e) => {
          e.preventDefault();
          if (np && np !== np2) return setMsg({ kind: "err", text: "两次输入的新密码不一致" });
          setBusy(true);
          setMsg(null);
          const r = await api("account", { currentPassword: cur, username: name, newPassword: np });
          setBusy(false);
          if (r.ok) {
            setMsg({ kind: "ok", text: "管理员账号已更新" });
            setCur("");
            setNp("");
            setNp2("");
            reload();
          } else setMsg({ kind: "err", text: r.data.error ?? "修改失败" });
        }}
      >
        <label className="block text-xs text-slate-400">
          账号
          <input
            className={`${input} mt-1`}
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="username"
            maxLength={32}
          />
        </label>
        <label className="block text-xs text-slate-400">
          当前密码
          <input
            className={`${input} mt-1`}
            type="password"
            value={cur}
            onChange={(e) => setCur(e.target.value)}
            autoComplete="current-password"
          />
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-xs text-slate-400">
            新密码（至少 8 位{state.mustChange ? "，必填" : "，不改请留空"}）
            <input
              className={`${input} mt-1`}
              type="password"
              value={np}
              onChange={(e) => setNp(e.target.value)}
              autoComplete="new-password"
              maxLength={128}
            />
          </label>
          <label className="block text-xs text-slate-400">
            确认新密码
            <input
              className={`${input} mt-1`}
              type="password"
              value={np2}
              onChange={(e) => setNp2(e.target.value)}
              autoComplete="new-password"
              maxLength={128}
            />
          </label>
        </div>
        <Notice msg={msg} />
        <button
          disabled={busy || !cur || (state.mustChange && np.length < 8)}
          className={`${btn} bg-sky-500 text-white hover:bg-sky-400`}
        >
          {busy ? "保存中…" : "保存修改"}
        </button>
      </form>
    </section>
  );
}
