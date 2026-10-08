"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useDialogs } from "../dialogs";
import { sysApi } from "../sys-store";
import { fmtSize } from "./sysfiles-app";

type Proc = {
  pid: number;
  ppid: number;
  name: string;
  state: string;
  user: string;
  cpu: number;
  mem: number;
  rss: number;
  cmd: string;
};

type Info = {
  user: string;
  host: string;
  os: string;
  kernel: string;
  arch: string;
  node: string;
  uptime: number;
  cpuModel: string;
  cores: number;
  load: number[];
  cpu: number;
  mem: { total: number; available: number; swapTotal: number; swapFree: number };
  disk: { total: number; free: number } | null;
  nets: { name: string; address: string; family: string; mac: string; internal: boolean }[];
  processTotal: number;
  procs: Proc[];
  selfPid: number;
};

function Spark({ data, color }: { data: number[]; color: string }) {
  const w = 240;
  const h = 56;
  const pts = data
    .map((v, i) => `${(i / Math.max(1, 59)) * w},${h - (Math.min(100, v) / 100) * h}`)
    .join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-14 w-full" preserveAspectRatio="none">
      <polyline points={`0,${h} ${pts} ${((data.length - 1) / 59) * w},${h}`} fill={color} opacity="0.18" />
      <polyline points={pts} fill="none" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function Bar({ pct, color }: { pct: number; color: string }) {
  return (
    <div className="h-2 overflow-hidden rounded-full bg-white/10">
      <div
        className="h-full rounded-full transition-all duration-500"
        style={{ width: `${Math.min(100, Math.max(0, pct))}%`, background: color }}
      />
    </div>
  );
}

function fmtUptime(s: number) {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${d ? d + " 天 " : ""}${h} 小时 ${m} 分`;
}

export function MonitorApp() {
  const dlg = useDialogs();
  const [info, setInfo] = useState<Info | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cpuHist, setCpuHist] = useState<number[]>([]);
  const [memHist, setMemHist] = useState<number[]>([]);
  const [tab, setTab] = useState<"overview" | "procs">("overview");
  const [sort, setSort] = useState<"cpu" | "mem" | "pid">("cpu");
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<number | null>(null);
  const busy = useRef(false);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      if (busy.current || document.hidden) return;
      busy.current = true;
      try {
        const r = await fetch("/api/sys/info", { cache: "no-store" });
        if (!r.ok) throw new Error();
        const d = (await r.json()) as Info;
        if (!alive) return;
        setInfo(d);
        setError(null);
        setCpuHist((h) => [...h, d.cpu].slice(-60));
        setMemHist((h) => [...h, ((d.mem.total - d.mem.available) / d.mem.total) * 100].slice(-60));
      } catch {
        if (alive) setError("无法获取系统信息");
      } finally {
        busy.current = false;
      }
    };
    void tick();
    const t = setInterval(tick, 2000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const procs = useMemo(() => {
    if (!info) return [];
    const q = filter.trim().toLowerCase();
    const list = info.procs.filter(
      (p) => !q || p.name.toLowerCase().includes(q) || p.cmd.toLowerCase().includes(q) || String(p.pid) === q,
    );
    return [...list].sort((a, b) =>
      sort === "pid" ? a.pid - b.pid : sort === "mem" ? b.rss - a.rss : b.cpu - a.cpu || b.rss - a.rss,
    );
  }, [info, filter, sort]);

  const kill = async (p: Proc, force: boolean) => {
    const ok = await dlg.confirm({
      title: force ? "强制结束进程" : "结束进程",
      message: `向进程 ${p.name} (PID ${p.pid}) 发送 ${force ? "SIGKILL" : "SIGTERM"} 信号？这会真实终止服务器上的进程。`,
      danger: true,
      confirmText: force ? "强制结束" : "结束",
    });
    if (!ok) return;
    try {
      await sysApi.kill(p.pid, force ? "SIGKILL" : "SIGTERM");
      dlg.toast(`已向 ${p.name} 发送信号`);
    } catch (e) {
      dlg.toast(e instanceof Error ? e.message : "操作失败");
    }
  };

  if (!info) {
    return (
      <div className="grid h-full place-items-center text-sm text-slate-400">
        {error ?? "正在读取系统信息…"}
      </div>
    );
  }

  const memUsed = info.mem.total - info.mem.available;
  const memPct = (memUsed / info.mem.total) * 100;
  const diskUsed = info.disk ? info.disk.total - info.disk.free : 0;
  const diskPct = info.disk ? (diskUsed / info.disk.total) * 100 : 0;
  const swapUsed = info.mem.swapTotal - info.mem.swapFree;

  const card = "rounded-xl border border-white/10 bg-black/20 p-4";

  return (
    <div className="flex h-full flex-col @container">
      <div className="flex items-center gap-1 border-b border-white/10 px-2 py-1.5 text-sm">
        {(
          [
            ["overview", "📈 概览"],
            ["procs", `🧩 进程 (${info.processTotal})`],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`rounded-md px-3 py-1 hover:bg-white/10 ${tab === id ? "bg-white/10 text-[var(--accent)]" : ""}`}
          >
            {label}
          </button>
        ))}
        <span className="ml-auto pr-2 text-xs text-slate-500">每 2 秒刷新 · 数据来自 /proc</span>
      </div>

      {tab === "overview" ? (
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
          <div className="grid gap-3 @xl:grid-cols-2">
            <div className={card}>
              <div className="flex items-baseline justify-between">
                <span className="text-sm text-slate-300">CPU</span>
                <span className="text-2xl font-light tabular-nums">{info.cpu.toFixed(1)}%</span>
              </div>
              <Spark data={cpuHist} color="#38bdf8" />
              <div className="mt-1 truncate text-xs text-slate-500">
                {info.cpuModel} · {info.cores} 核 · 负载 {info.load.map((l) => l.toFixed(2)).join(" ")}
              </div>
            </div>
            <div className={card}>
              <div className="flex items-baseline justify-between">
                <span className="text-sm text-slate-300">内存</span>
                <span className="text-2xl font-light tabular-nums">{memPct.toFixed(1)}%</span>
              </div>
              <Spark data={memHist} color="#a78bfa" />
              <div className="mt-1 text-xs text-slate-500">
                已用 {fmtSize(memUsed)} / 共 {fmtSize(info.mem.total)}
                {info.mem.swapTotal > 0 && ` · 交换 ${fmtSize(swapUsed)}/${fmtSize(info.mem.swapTotal)}`}
              </div>
            </div>
          </div>

          {info.disk && (
            <div className={card}>
              <div className="mb-2 flex justify-between text-sm">
                <span className="text-slate-300">磁盘 /</span>
                <span className="tabular-nums text-slate-400">
                  {fmtSize(diskUsed)} / {fmtSize(info.disk.total)}（{diskPct.toFixed(0)}%）
                </span>
              </div>
              <Bar pct={diskPct} color={diskPct > 90 ? "#f87171" : "#34d399"} />
            </div>
          )}

          <div className="grid gap-3 @xl:grid-cols-2">
            <div className={card}>
              <h3 className="mb-2 text-sm font-semibold text-slate-300">系统</h3>
              <dl className="grid grid-cols-[5.5rem_1fr] gap-y-1 text-sm">
                {[
                  ["主机名", info.host],
                  ["用户", info.user],
                  ["操作系统", info.os],
                  ["内核", `${info.kernel} (${info.arch})`],
                  ["运行时间", fmtUptime(info.uptime)],
                  ["Node.js", info.node],
                  ["进程数", String(info.processTotal)],
                ].map(([k, v]) => (
                  <div key={k} className="contents">
                    <dt className="text-slate-500">{k}</dt>
                    <dd className="truncate text-slate-200" title={v}>
                      {v}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
            <div className={card}>
              <h3 className="mb-2 text-sm font-semibold text-slate-300">网络接口</h3>
              <div className="space-y-1 text-sm">
                {info.nets.length === 0 && <div className="text-slate-500">无</div>}
                {info.nets.map((n, i) => (
                  <div key={i} className="flex justify-between gap-2">
                    <span className="text-slate-400">{n.name}</span>
                    <span className="truncate tabular-nums text-slate-200">{n.address}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex items-center gap-2 border-b border-white/10 p-2">
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="🔍 按名称 / 命令 / PID 过滤"
              className="min-w-0 flex-1 rounded-lg border border-white/10 bg-black/30 px-3 py-1 text-sm outline-none focus:border-[var(--accent)]"
            />
            {selected !== null && procs.find((p) => p.pid === selected) && (
              <>
                <button
                  className="rounded-md bg-white/10 px-3 py-1 text-xs hover:bg-white/20"
                  onClick={() => void kill(procs.find((p) => p.pid === selected)!, false)}
                >
                  结束
                </button>
                <button
                  className="rounded-md bg-red-500/80 px-3 py-1 text-xs hover:bg-red-500"
                  onClick={() => void kill(procs.find((p) => p.pid === selected)!, true)}
                >
                  强制结束
                </button>
              </>
            )}
          </div>
          <div className="grid grid-cols-[3.5rem_1fr_4rem_4rem] gap-2 border-b border-white/10 px-3 py-1.5 text-xs text-slate-400 @xl:grid-cols-[3.5rem_9rem_1fr_5rem_4rem_4rem]">
            <button className="text-left" onClick={() => setSort("pid")}>
              PID{sort === "pid" ? " ▲" : ""}
            </button>
            <span className="hidden @xl:block">用户</span>
            <span>名称</span>
            <span className="hidden @xl:block">状态</span>
            <button className="text-right" onClick={() => setSort("cpu")}>
              CPU{sort === "cpu" ? " ▼" : ""}
            </button>
            <button className="text-right" onClick={() => setSort("mem")}>
              内存{sort === "mem" ? " ▼" : ""}
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {procs.map((p) => (
              <button
                key={p.pid}
                onClick={() => setSelected(p.pid)}
                title={p.cmd}
                className={`grid w-full grid-cols-[3.5rem_1fr_4rem_4rem] gap-2 px-3 py-1 text-left text-xs tabular-nums @xl:grid-cols-[3.5rem_9rem_1fr_5rem_4rem_4rem] ${
                  selected === p.pid ? "bg-[var(--accent)]/25" : "hover:bg-white/5"
                } ${p.pid === info.selfPid ? "text-sky-300" : ""}`}
              >
                <span className="text-slate-400">{p.pid}</span>
                <span className="hidden truncate @xl:block">{p.user}</span>
                <span className="truncate">{p.cmd.length > 0 ? p.cmd : p.name}</span>
                <span className="hidden text-slate-400 @xl:block">{p.state}</span>
                <span className="text-right">{p.cpu.toFixed(1)}%</span>
                <span className="text-right">{fmtSize(p.rss)}</span>
              </button>
            ))}
            {procs.length === 0 && (
              <div className="py-10 text-center text-sm text-slate-500">没有匹配的进程</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
