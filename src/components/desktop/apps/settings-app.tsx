"use client";

import { useState } from "react";
import { useDialogs } from "../dialogs";
import { ACCENTS, WALLPAPERS } from "../defs";
import { useFs } from "../fs-store";
import { useWm } from "../wm-store";

type Tab = "personal" | "time" | "system";

export function SettingsApp() {
  const fs = useFs();
  const wm = useWm();
  const dlg = useDialogs();
  const [tab, setTab] = useState<Tab>("personal");
  const [url, setUrl] = useState(fs.settings.customWallpaper ?? "");

  const wallpaper = fs.settings.wallpaper ?? "img1";
  const accent = fs.settings.accent ?? "blue";
  const clock24 = (fs.settings.clock24 ?? "1") === "1";

  const files = fs.nodes.filter((n) => n.kind === "file");
  const dirs = fs.nodes.filter((n) => n.kind === "folder");
  const bytes = files.reduce((s, n) => s + new Blob([n.content]).size, 0);

  const tabs: { id: Tab; label: string; icon: string }[] = [
    { id: "personal", label: "个性化", icon: "🎨" },
    { id: "time", label: "时间", icon: "🕒" },
    { id: "system", label: "系统", icon: "💻" },
  ];

  return (
    <div className="flex h-full flex-col @container sm:flex-row">
      <nav className="flex shrink-0 gap-1 border-b border-white/10 p-2 sm:w-40 sm:flex-col sm:border-b-0 sm:border-r">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex items-center gap-2 rounded-lg px-3 py-2 text-sm hover:bg-white/10 ${
              tab === t.id ? "bg-white/10 text-[var(--accent)]" : ""
            }`}
          >
            <span>{t.icon}</span>
            {t.label}
          </button>
        ))}
      </nav>

      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        {tab === "personal" && (
          <div className="space-y-6">
            <section>
              <h3 className="mb-3 text-sm font-semibold text-slate-300">桌面壁纸</h3>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                {WALLPAPERS.map((w) => (
                  <button
                    key={w.id}
                    onClick={() => fs.setSetting("wallpaper", w.id)}
                    className={`group overflow-hidden rounded-xl border-2 text-left ${
                      wallpaper === w.id ? "border-[var(--accent)]" : "border-transparent"
                    }`}
                  >
                    <div className="aspect-video" style={{ background: w.css }} />
                    <div className="bg-black/30 px-2 py-1 text-xs">{w.name}</div>
                  </button>
                ))}
              </div>
              <form
                className="mt-3 flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!/^https?:\/\//.test(url.trim())) return dlg.toast("请输入 http(s) 图片链接");
                  fs.setSetting("customWallpaper", url.trim());
                  fs.setSetting("wallpaper", "custom");
                }}
              >
                <input
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="自定义壁纸图片链接 https://…"
                  className="min-w-0 flex-1 rounded-lg border border-white/10 bg-black/30 px-3 py-1.5 text-sm outline-none focus:border-[var(--accent)]"
                />
                <button className="rounded-lg bg-[var(--accent)] px-4 py-1.5 text-sm font-medium text-white">
                  应用
                </button>
              </form>
            </section>
            <section>
              <h3 className="mb-3 text-sm font-semibold text-slate-300">主题色</h3>
              <div className="flex gap-3">
                {ACCENTS.map((a) => (
                  <button
                    key={a.id}
                    onClick={() => fs.setSetting("accent", a.id)}
                    aria-label={a.id}
                    className={`h-9 w-9 rounded-full ring-offset-2 ring-offset-slate-800 transition ${
                      accent === a.id ? "ring-2 ring-white" : "hover:scale-110"
                    }`}
                    style={{ background: a.color }}
                  />
                ))}
              </div>
            </section>
          </div>
        )}

        {tab === "time" && (
          <section>
            <h3 className="mb-3 text-sm font-semibold text-slate-300">时钟格式</h3>
            <div className="flex gap-2">
              {[
                { v: "1", l: "24 小时制" },
                { v: "0", l: "12 小时制" },
              ].map((o) => (
                <button
                  key={o.v}
                  onClick={() => fs.setSetting("clock24", o.v)}
                  className={`rounded-lg border px-4 py-2 text-sm ${
                    clock24 === (o.v === "1")
                      ? "border-[var(--accent)] bg-[var(--accent)]/20"
                      : "border-white/10 hover:bg-white/10"
                  }`}
                >
                  {o.l}
                </button>
              ))}
            </div>
            <p className="mt-4 text-sm text-slate-400">时区：{Intl.DateTimeFormat().resolvedOptions().timeZone}</p>
          </section>
        )}

        {tab === "system" && (
          <section className="space-y-5">
            <div className="rounded-xl border border-white/10 bg-black/20 p-4 text-sm">
              <div className="mb-3 flex items-center gap-3">
                <span className="grid h-12 w-12 place-items-center rounded-xl bg-gradient-to-br from-[var(--accent)] to-fuchsia-500 text-2xl">
                  🖥️
                </span>
                <div>
                  <div className="text-base font-semibold">WebDesktop 1.0</div>
                  <div className="text-slate-400">运行在浏览器中的模拟桌面系统</div>
                </div>
              </div>
              <dl className="grid grid-cols-[6rem_1fr] gap-y-1.5 text-slate-300">
                <dt className="text-slate-500">文件</dt>
                <dd>{files.length} 个</dd>
                <dt className="text-slate-500">文件夹</dt>
                <dd>{dirs.length} 个</dd>
                <dt className="text-slate-500">占用空间</dt>
                <dd>{(bytes / 1024).toFixed(1)} KB</dd>
                <dt className="text-slate-500">打开的窗口</dt>
                <dd>{wm.wins.length}</dd>
                <dt className="text-slate-500">存储</dt>
                <dd>PostgreSQL（服务器端持久化）</dd>
              </dl>
            </div>
            <div>
              <h3 className="mb-2 text-sm font-semibold text-slate-300">危险操作</h3>
              <button
                onClick={async () => {
                  const ok = await dlg.confirm({
                    title: "重置系统",
                    message: "将删除所有文件并恢复默认设置，无法撤销。",
                    danger: true,
                    confirmText: "重置",
                  });
                  if (ok) {
                    await fs.reset();
                    dlg.toast("系统已重置");
                  }
                }}
                className="rounded-lg border border-red-400/40 px-4 py-2 text-sm text-red-300 hover:bg-red-500/20"
              >
                重置系统数据
              </button>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
