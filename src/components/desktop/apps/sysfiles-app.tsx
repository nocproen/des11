"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { useContextMenu } from "../context-menu";
import { useDialogs } from "../dialogs";
import { nodeIcon } from "../defs";
import {
  SYS_DRAG_KEY,
  baseName,
  joinPath,
  sysApi,
  useSys,
  useSysOps,
  type SysEntry,
} from "../sys-store";
import { entryExtraMenu, openEntry } from "../open-entry";
import { useWm, type Win } from "../wm-store";

type SortKey = "name" | "mtime" | "size";

export function fmtSize(n: number) {
  if (n < 1024) return `${n} B`;
  const u = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${u[i]}`;
}

function fmtDate(ms: number) {
  const d = new Date(ms);
  return d.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export function SysFilesApp({ win }: { win: Win }) {
  const wm = useWm();
  const dlg = useDialogs();
  const menu = useContextMenu();
  const ops = useSysOps();
  const { info, version } = useSys();

  const path = win.path ?? "~";
  const [data, setData] = useState<{ path: string; parent: string | null; entries: SysEntry[] } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [sort, setSort] = useState<{ key: SortKey; asc: boolean }>({ key: "name", asc: true });
  const hist = useRef<{ stack: string[]; idx: number }>({ stack: [path], idx: 0 });
  const [, force] = useState(0);

  const load = useCallback(async () => {
    try {
      const r = await sysApi.list(path, true);
      setData(r);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "无法读取目录");
    }
  }, [path]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    const t = setInterval(() => !document.hidden && void load(), 4000);
    return () => clearInterval(t);
  }, [load, version]);

  const cur = data?.path ?? path;
  const inTrash = !!info && (cur === info.trash || cur.startsWith(info.trash + "/"));

  const goto = (p: string, push = true) => {
    const h = hist.current;
    if (push) {
      h.stack = [...h.stack.slice(0, h.idx + 1), p];
      h.idx = h.stack.length - 1;
    }
    setSelected(null);
    setData(null);
    setError(null);
    wm.patch(win.id, { path: p });
    force((n) => n + 1);
  };
  const back = () => {
    const h = hist.current;
    if (h.idx > 0) goto(h.stack[--h.idx], false);
  };
  const forward = () => {
    const h = hist.current;
    if (h.idx < h.stack.length - 1) goto(h.stack[++h.idx], false);
  };

  const entries = useMemo(() => {
    const list = (data?.entries ?? []).filter((e) => showHidden || !e.hidden);
    const dir = sort.asc ? 1 : -1;
    return [...list].sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
      if (sort.key === "size") return (a.size - b.size) * dir;
      if (sort.key === "mtime") return (a.mtime - b.mtime) * dir;
      return a.name.localeCompare(b.name, "zh") * dir;
    });
  }, [data, showHidden, sort]);

  const open = (e: SysEntry) => {
    if (e.kind === "folder") goto(e.path);
    else openEntry(wm, e);
  };

  const termHere = (dir: string) => wm.open("systerm", { path: dir });

  const entryMenu = (e: React.MouseEvent, en: SysEntry) => {
    setSelected(en.path);
    if (inTrash) {
      return menu.show(e, [
        { label: "还原", icon: "↩️", onClick: () => void ops.restore(en.path) },
        { divider: true },
        { label: "永久删除", icon: "❌", danger: true, onClick: () => void ops.destroy(en.path) },
      ]);
    }
    menu.show(e, [
      { label: "打开", icon: "📂", onClick: () => open(en) },
      ...entryExtraMenu(wm, en),
      {
        label: "在终端中打开",
        icon: "⌨️",
        onClick: () => termHere(en.kind === "folder" ? en.path : cur),
      },
      { label: "重命名", icon: "✏️", onClick: () => void ops.renameDialog(en.path) },
      {
        label: "复制路径",
        icon: "📋",
        onClick: () => {
          void navigator.clipboard?.writeText(en.path);
          dlg.toast("路径已复制");
        },
      },
      ...(en.kind === "file"
        ? [
            {
              label: "下载",
              icon: "⬇️",
              onClick: () => window.open(`/api/sys/raw?path=${encodeURIComponent(en.path)}&download=1`),
            },
          ]
        : []),
      { divider: true },
      { label: "移到回收站", icon: "🗑️", danger: true, onClick: () => void ops.trash(en.path) },
    ]);
  };

  const blankMenu = (e: React.MouseEvent) => {
    if (inTrash) {
      return menu.show(e, [
        { label: "清空回收站", icon: "🗑️", danger: true, onClick: () => void ops.emptyTrash() },
        { label: "刷新", icon: "🔄", onClick: () => void load() },
      ]);
    }
    menu.show(e, [
      { label: "新建文件夹", icon: "📁", onClick: () => void ops.newItem(cur, "folder") },
      { label: "新建文本文档", icon: "📄", onClick: () => void ops.newItem(cur, "file") },
      { divider: true },
      { label: "在此处打开终端", icon: "⌨️", onClick: () => termHere(cur) },
      {
        label: showHidden ? "隐藏隐藏文件" : "显示隐藏文件",
        icon: "👁️",
        onClick: () => setShowHidden((v) => !v),
      },
      { label: "刷新", icon: "🔄", onClick: () => void load() },
    ]);
  };

  // 拖拽移动真实文件
  const dropInto = (target: string | null, trash = false) => ({
    onDragOver: (e: DragEvent) => {
      if (e.dataTransfer.types.includes(SYS_DRAG_KEY)) {
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "move";
      }
    },
    onDrop: async (e: DragEvent) => {
      const src = e.dataTransfer.getData(SYS_DRAG_KEY);
      if (!src || !target) return;
      e.preventDefault();
      e.stopPropagation();
      if (src === target) return;
      if (trash) await ops.trash(src);
      else await ops.move(src, target);
      void load();
    },
  });

  const onKey = (e: React.KeyboardEvent) => {
    const en = entries.find((x) => x.path === selected);
    if (!en) return;
    if (e.key === "Enter") open(en);
    if (e.key === "F2") void ops.renameDialog(en.path);
    if (e.key === "Delete") void (inTrash ? ops.destroy(en.path) : ops.trash(en.path));
  };

  const places = info
    ? [
        { label: "主目录", icon: "🏠", p: info.home },
        { label: "桌面", icon: "🖥️", p: info.desktop },
        { label: "文档", icon: "📚", p: info.documents },
        { label: "下载", icon: "⬇️", p: info.downloads },
        { label: "图片", icon: "🖼️", p: info.pictures },
        { label: "回收站", icon: "🗑️", p: info.trash, trash: true },
        { label: "文件系统 /", icon: "💽", p: "/" },
        { label: "/etc", icon: "⚙️", p: "/etc" },
        { label: "/var/log", icon: "🧾", p: "/var/log" },
        { label: "/tmp", icon: "🧹", p: "/tmp" },
      ]
    : [];

  const crumbs = useMemo(() => {
    const parts = cur.split("/").filter(Boolean);
    return [
      { label: "/", p: "/" },
      ...parts.map((s, i) => ({ label: s, p: "/" + parts.slice(0, i + 1).join("/") })),
    ];
  }, [cur]);

  const btn =
    "grid h-7 w-7 place-items-center rounded-md text-base hover:bg-white/10 disabled:opacity-30 disabled:hover:bg-transparent";
  const th = (key: SortKey, label: string, cls = "") => (
    <button
      className={`text-left text-xs text-slate-400 hover:text-slate-200 ${cls}`}
      onClick={() => setSort((s) => ({ key, asc: s.key === key ? !s.asc : true }))}
    >
      {label}
      {sort.key === key ? (sort.asc ? " ▲" : " ▼") : ""}
    </button>
  );

  return (
    <div className="flex h-full flex-col @container" onKeyDown={onKey} tabIndex={-1}>
      <div className="flex items-center gap-1 border-b border-white/10 bg-white/[0.03] px-2 py-1.5">
        <button className={btn} onClick={back} disabled={hist.current.idx === 0} title="后退">
          ←
        </button>
        <button
          className={btn}
          onClick={forward}
          disabled={hist.current.idx >= hist.current.stack.length - 1}
          title="前进"
        >
          →
        </button>
        <button className={btn} onClick={() => data?.parent && goto(data.parent)} disabled={!data?.parent} title="上一级">
          ↑
        </button>
        <div className="mx-1 flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto whitespace-nowrap rounded-md border border-white/10 bg-black/20 px-2 py-1 text-xs">
          {crumbs.map((c, i) => (
            <span key={c.p} className="flex items-center">
              {i > 1 && <span className="px-0.5 text-slate-500">/</span>}
              <button className="rounded px-1 hover:bg-white/10" onClick={() => goto(c.p)}>
                {c.label}
              </button>
            </span>
          ))}
        </div>
        {!inTrash && (
          <>
            <button
              className="rounded-md px-2 py-1 text-xs hover:bg-white/10"
              onClick={() => void ops.newItem(cur, "folder")}
            >
              ＋ 文件夹
            </button>
            <button
              className="rounded-md px-2 py-1 text-xs hover:bg-white/10"
              onClick={() => void ops.newItem(cur, "file")}
            >
              ＋ 文件
            </button>
          </>
        )}
        {inTrash && (
          <button
            className="rounded-md px-2 py-1 text-xs text-red-300 hover:bg-red-500/20"
            onClick={() => void ops.emptyTrash()}
          >
            清空回收站
          </button>
        )}
        <button
          title="终端"
          className="rounded-md px-2 py-1 text-xs hover:bg-white/10"
          onClick={() => termHere(cur)}
        >
          ⌨️
        </button>
        <button
          title="显示/隐藏隐藏文件"
          className={`rounded-md px-2 py-1 text-xs hover:bg-white/10 ${showHidden ? "bg-white/10" : ""}`}
          onClick={() => setShowHidden((v) => !v)}
        >
          👁️
        </button>
      </div>

      <div className="flex min-h-0 flex-1">
        <nav className="hidden w-40 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-white/10 p-2 text-sm @lg:flex">
          {places.map((s) => (
            <button
              key={s.p}
              onClick={() => goto(s.p)}
              {...dropInto(s.trash ? s.p : s.p, !!s.trash)}
              className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-white/10 ${
                cur === s.p ? "bg-white/10 text-[var(--accent)]" : ""
              }`}
            >
              <span>{s.icon}</span>
              <span className="truncate">{s.label}</span>
            </button>
          ))}
        </nav>

        <div
          className="flex min-w-0 flex-1 flex-col"
          {...dropInto(inTrash ? null : cur)}
          onContextMenu={blankMenu}
          onClick={() => setSelected(null)}
        >
          <div className="grid grid-cols-[1fr_5rem] gap-2 border-b border-white/10 px-3 py-1.5 @xl:grid-cols-[1fr_9rem_5rem]">
            {th("name", "名称")}
            {th("mtime", "修改时间", "hidden @xl:block")}
            {th("size", "大小", "text-right")}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {error ? (
              <div className="grid h-full min-h-32 place-items-center px-4 text-center text-sm text-red-300">
                {error}
              </div>
            ) : !data ? (
              <div className="grid h-full min-h-32 place-items-center text-sm text-slate-500">加载中…</div>
            ) : entries.length === 0 ? (
              <div className="grid h-full min-h-32 place-items-center text-sm text-slate-500">
                {inTrash ? "回收站是空的" : "此目录为空，右键可新建"}
              </div>
            ) : (
              entries.map((en) => (
                <button
                  key={en.path}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData(SYS_DRAG_KEY, en.path);
                    e.dataTransfer.effectAllowed = "move";
                  }}
                  {...(en.kind === "folder" && !inTrash ? dropInto(en.path) : {})}
                  onClick={(e) => {
                    e.stopPropagation();
                    setSelected(en.path);
                    if (wm.isMobile) open(en);
                  }}
                  onDoubleClick={() => open(en)}
                  onContextMenu={(e) => entryMenu(e, en)}
                  className={`grid w-full grid-cols-[1fr_5rem] items-center gap-2 border-y border-transparent px-3 py-1 text-left text-sm @xl:grid-cols-[1fr_9rem_5rem] ${
                    selected === en.path
                      ? "border-[var(--accent)]/40 bg-[var(--accent)]/20"
                      : "hover:bg-white/5"
                  } ${en.hidden ? "opacity-60" : ""}`}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="text-lg">{en.kind === "folder" ? "📁" : nodeIcon(en.name, "file")}</span>
                    <span className="truncate">{en.name}</span>
                    {en.link && <span className="text-xs text-slate-500">↪</span>}
                  </span>
                  <span className="hidden text-xs text-slate-400 @xl:block">{fmtDate(en.mtime)}</span>
                  <span className="text-right text-xs text-slate-400">
                    {en.kind === "folder" ? "—" : fmtSize(en.size)}
                  </span>
                </button>
              ))
            )}
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between border-t border-white/10 px-3 py-1 text-xs text-slate-400">
        <span>{entries.length} 个项目</span>
        <span className="truncate pl-2">
          {selected ? joinPath(cur, baseName(selected)) : cur}
        </span>
      </div>
    </div>
  );
}
