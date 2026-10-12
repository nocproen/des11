"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AppIcon } from "./app-icon";
import { useContextMenu } from "./context-menu";
import { nodeIcon } from "./defs";
import { useDialogs } from "./dialogs";
import { useFs } from "./fs-store";
import { guiIconUrl, useSys } from "./sys-store";
import { useNodeActions } from "./node-actions";
import { APPS, useWm, type AppId } from "./wm-store";

function useNow() {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

export function Taskbar({
  startOpen,
  setStartOpen,
}: {
  startOpen: boolean;
  setStartOpen: (v: boolean) => void;
}) {
  const wm = useWm();
  const fs = useFs();
  const now = useNow();
  const clock24 = (fs.settings.clock24 ?? "1") === "1";

  const time = now
    ? now.toLocaleTimeString("zh-CN", { hour12: !clock24, hour: "2-digit", minute: "2-digit" })
    : "";
  const date = now
    ? now.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric", weekday: "short" })
    : "";

  return (
    <div
      className="absolute inset-x-0 bottom-0 z-[8000] flex h-14 items-center border-t border-white/10 bg-slate-900/70 px-2 backdrop-blur-2xl"
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="flex min-w-0 flex-1 items-center justify-start gap-1 overflow-x-auto sm:justify-center">
        <button
          id="start-button"
          onClick={() => setStartOpen(!startOpen)}
          aria-label="开始"
          className={`grid h-10 w-10 place-items-center rounded-lg transition hover:bg-white/10 ${
            startOpen ? "bg-white/10" : ""
          }`}
        >
          <span className="grid grid-cols-2 gap-0.5">
            {[0, 1, 2, 3].map((i) => (
              <span key={i} className="h-2.5 w-2.5 rounded-[2px] bg-[var(--accent)]" />
            ))}
          </span>
        </button>
        {(Object.keys(APPS) as AppId[])
          .filter((id) => id !== "gui" && (!APPS[id].hidden || wm.wins.some((w) => w.app === id)))
          .map((id) => {
          const mine = wm.wins.filter((w) => w.app === id);
          const active = mine.some((w) => w.id === wm.focusedId);
          return (
            <button
              key={id}
              title={APPS[id].name}
              onClick={() => {
                setStartOpen(false);
                wm.toggleApp(id);
              }}
              className={`relative grid h-10 w-10 place-items-center rounded-lg text-xl transition hover:bg-white/10 ${
                active ? "bg-white/15" : ""
              }`}
            >
              {APPS[id].icon}
              {mine.length > 0 && (
                <span
                  className={`absolute bottom-0.5 h-1 rounded-full bg-[var(--accent)] ${
                    active ? "w-4" : "w-1.5"
                  }`}
                />
              )}
            </button>
          );
        })}
        {/* 每个图形应用窗口在任务栏上有自己的图标 */}
        {wm.wins
          .filter((w) => w.app === "gui")
          .map((w) => {
            const active = wm.focusedId === w.id;
            return (
              <button
                key={w.id}
                title={w.title || "应用"}
                onClick={() => {
                  setStartOpen(false);
                  if (active) wm.minimize(w.id);
                  else wm.focus(w.id);
                }}
                className={`relative grid h-10 w-10 shrink-0 place-items-center rounded-lg transition hover:bg-white/10 ${
                  active ? "bg-white/15" : ""
                }`}
              >
                <AppIcon url={w.iconUrl} fallback="🚀" size={26} />
                <span className={`absolute bottom-0.5 h-1 rounded-full bg-[var(--accent)] ${active ? "w-4" : "w-1.5"}`} />
              </button>
            );
          })}
      </div>

      <div className="flex items-center gap-1">
        <div className="hidden px-3 text-right text-xs leading-tight text-slate-200 sm:block">
          <div className="font-medium tabular-nums">{time}</div>
          <div className="text-slate-400">{date}</div>
        </div>
        <div className="px-2 text-xs tabular-nums text-slate-200 sm:hidden">{time}</div>
        <button
          onClick={() => wm.showDesktop()}
          title="显示桌面"
          aria-label="显示桌面"
          className="h-10 w-2.5 border-l border-white/20 hover:bg-white/15"
        />
      </div>
    </div>
  );
}

export function StartMenu({ onClose }: { onClose: () => void }) {
  const wm = useWm();
  const fs = useFs();
  const act = useNodeActions();
  const [q, setQ] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const menu = useContextMenu();
  const dlg = useDialogs();
  const { bump } = useSys();
  type Installed = { file: string; name: string; icon: string; comment: string; exec: string };
  const [installed, setInstalled] = useState<Installed[]>([]);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let alive = true;
    fetch("/api/gui/apps", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { apps: [] }))
      .then((d: { apps: Installed[] }) => alive && setInstalled(d.apps ?? []))
      .catch(() => {})
      .finally(() => alive && setLoaded(true));
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement;
      if (ref.current && !ref.current.contains(t) && !t.closest("#start-button") && !t.closest("[data-ctxmenu]")) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const query = q.trim().toLowerCase();
  const apps = (Object.keys(APPS) as AppId[]).filter(
    (id) => !APPS[id].hidden && (!query || APPS[id].name.toLowerCase().includes(query) || id.includes(query)),
  );
  const matches = useMemo(
    () =>
      query
        ? fs.nodes.filter((n) => n.name.toLowerCase().includes(query) && !fs.isInTrash(n.id)).slice(0, 8)
        : fs.nodes
            .filter((n) => n.kind === "file" && !fs.isInTrash(n.id))
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
            .slice(0, 4),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [query, fs.nodes],
  );

  const shown = installed.filter(
    (a) => !query || a.name.toLowerCase().includes(query) || a.exec.toLowerCase().includes(query),
  );

  return (
    <div
      ref={ref}
      className="absolute bottom-16 left-2 z-[8500] max-h-[calc(100vh-5rem)] w-[min(26rem,calc(100vw-1rem))] overflow-y-auto animate-[pop_0.15s_ease-out] rounded-2xl border border-white/10 bg-slate-900/85 p-4 text-slate-100 shadow-2xl backdrop-blur-2xl sm:left-1/2 sm:-translate-x-1/2"
    >
      <input
        autoFocus
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="🔍 搜索应用和文件…"
        className="w-full rounded-full border border-white/10 bg-black/30 px-4 py-2 text-sm outline-none focus:border-[var(--accent)]"
      />
      {apps.length > 0 && (
        <>
          <div className="mb-2 mt-4 text-xs text-slate-400">应用</div>
          <div className="grid grid-cols-4 gap-2">
            {apps.map((id) => (
              <button
                key={id}
                onClick={() => {
                  wm.open(id, id === "files" ? { folderId: null } : id === "sysfiles" ? { path: "~" } : {});
                  onClose();
                }}
                className="flex flex-col items-center gap-1.5 rounded-xl p-2 hover:bg-white/10"
              >
                <span
                  className={`grid h-11 w-11 place-items-center rounded-xl bg-gradient-to-br text-2xl ${APPS[id].gradient}`}
                >
                  {APPS[id].icon}
                </span>
                <span className="text-xs">{APPS[id].name}</span>
              </button>
            ))}
          </div>
        </>
      )}
      {(shown.length > 0 || (!query && loaded)) && (
        <>
          <div className="mb-2 mt-4 flex items-center justify-between text-xs text-slate-400">
            <span>已安装的应用</span>
            {shown.length > 0 && <span className="text-slate-600">右键可添加到桌面</span>}
          </div>
          {shown.length === 0 ? (
            <div className="rounded-xl bg-white/5 px-3 py-3 text-xs leading-relaxed text-slate-400">
              还没有可用的图形应用。在终端里用 <code className="text-slate-200">sudo apt install ./软件.deb</code> 安装后，
              会自动出现在这里；也可以用 <code className="text-slate-200">gui 命令</code> 直接运行。
            </div>
          ) : (
            <div className="grid grid-cols-4 gap-2">
              {shown.map((a) => (
                <button
                  key={a.file}
                  title={a.comment || a.exec}
                  onClick={() => {
                    wm.open("gui", {
                      desktopFile: a.file,
                      name: a.name,
                      iconUrl: a.icon ? guiIconUrl(a.icon) : undefined,
                    });
                    onClose();
                  }}
                  onContextMenu={(e) =>
                    menu.show(e, [
                      {
                        label: "添加到桌面",
                        icon: "🖥️",
                        onClick: async () => {
                          const r = await fetch("/api/gui/shortcut", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ file: a.file }),
                          });
                          dlg.toast(r.ok ? `已把「${a.name}」添加到桌面` : "添加失败");
                          if (r.ok) bump();
                        },
                      },
                    ])
                  }
                  className="flex flex-col items-center gap-1.5 rounded-xl p-2 hover:bg-white/10"
                >
                  <span className="grid h-11 w-11 place-items-center rounded-xl bg-white/10">
                    <AppIcon url={a.icon ? guiIconUrl(a.icon) : undefined} fallback="🧩" size={34} />
                  </span>
                  <span className="line-clamp-2 w-full break-words text-center text-xs leading-tight">{a.name}</span>
                </button>
              ))}
            </div>
          )}
        </>
      )}
      {matches.length > 0 && (
        <>
          <div className="mb-1 mt-4 text-xs text-slate-400">{query ? "搜索结果" : "最近的文件"}</div>
          <div className="space-y-0.5">
            {matches.map((n) => (
              <button
                key={n.id}
                onClick={() => {
                  act.openNode(n);
                  onClose();
                }}
                className="flex w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-white/10"
              >
                <span className="text-lg">{nodeIcon(n.name, n.kind, n.parentId === null)}</span>
                <span className="min-w-0 flex-1 truncate">{n.name}</span>
                <span className="max-w-[40%] truncate text-xs text-slate-500">
                  {fs.pathOf(n.parentId)}
                </span>
              </button>
            ))}
          </div>
        </>
      )}
      {query && apps.length === 0 && matches.length === 0 && (
        <div className="py-8 text-center text-sm text-slate-500">没有找到匹配项</div>
      )}
      <div className="mt-4 flex items-center justify-between border-t border-white/10 pt-3 text-xs">
        <span className="flex items-center gap-2 text-slate-300">
          <span className="grid h-7 w-7 place-items-center rounded-full bg-[var(--accent)] text-sm">
            👤
          </span>
          访客
        </span>
        <span className="flex gap-1">
          <button
            onClick={() => {
              if (document.fullscreenElement) void document.exitFullscreen();
              else void document.documentElement.requestFullscreen?.();
              onClose();
            }}
            className="rounded-md px-2 py-1 hover:bg-white/10"
          >
            ⛶ 全屏
          </button>
          <button
            onClick={() => {
              void fs.reload();
              onClose();
            }}
            className="rounded-md px-2 py-1 hover:bg-white/10"
          >
            🔄 刷新
          </button>
          <button
            onClick={async () => {
              await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
              window.location.reload();
            }}
            className="rounded-md px-2 py-1 text-amber-300 hover:bg-white/10"
          >
            🔒 锁定
          </button>
        </span>
      </div>
    </div>
  );
}
