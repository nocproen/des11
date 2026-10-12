"use client";

import { useRef, useState } from "react";
import { useContextMenu } from "../context-menu";
import { useDialogs } from "../dialogs";
import { nodeIcon } from "../defs";
import { useFs, type FsNode } from "../fs-store";
import { useNodeActions } from "../node-actions";
import { useWm, type Win } from "../wm-store";

export function FilesApp({ win }: { win: Win }) {
  const fs = useFs();
  const wm = useWm();
  const dlg = useDialogs();
  const menu = useContextMenu();
  const act = useNodeActions();

  const folderId = win.folderId ?? null;
  const current = fs.get(folderId);
  const items = fs.children(folderId);
  const inTrash = fs.isInTrash(folderId);
  const [selected, setSelected] = useState<number | null>(null);
  const history = useRef<{ stack: (number | null)[]; idx: number }>({
    stack: [folderId],
    idx: 0,
  });
  const [, force] = useState(0);

  const goto = (id: number | null, push = true) => {
    const h = history.current;
    if (push) {
      h.stack = [...h.stack.slice(0, h.idx + 1), id];
      h.idx = h.stack.length - 1;
    }
    wm.patch(win.id, { folderId: id });
    setSelected(null);
    force((n) => n + 1);
  };
  const back = () => {
    const h = history.current;
    if (h.idx > 0) {
      h.idx--;
      goto(h.stack[h.idx], false);
    }
  };
  const forward = () => {
    const h = history.current;
    if (h.idx < h.stack.length - 1) {
      h.idx++;
      goto(h.stack[h.idx], false);
    }
  };
  const up = () => goto(current?.parentId ?? null);
  const canBack = history.current.idx > 0;
  const canForward = history.current.idx < history.current.stack.length - 1;

  const open = (n: FsNode) => act.openNode(n, (f) => goto(f.id));

  const blankMenu = (e: React.MouseEvent) => {
    if (folderId === null) {
      menu.show(e, [{ label: "刷新", icon: "🔄", onClick: () => void fs.reload() }]);
      return;
    }
    if (inTrash) {
      menu.show(e, [
        { label: "清空回收站", icon: "🗑️", danger: true, onClick: () => void emptyTrash() },
        { label: "刷新", icon: "🔄", onClick: () => void fs.reload() },
      ]);
      return;
    }
    menu.show(e, [
      { label: "新建文件夹", icon: "📁", onClick: () => void act.newItem(folderId, "folder") },
      { label: "新建文本文档", icon: "📄", onClick: () => void act.newItem(folderId, "file") },
      { divider: true },
      { label: "刷新", icon: "🔄", onClick: () => void fs.reload() },
    ]);
  };

  const emptyTrash = async () => {
    if (!items.length) return dlg.toast("回收站已经是空的");
    const ok = await dlg.confirm({
      title: "清空回收站",
      message: `将永久删除 ${items.length} 个项目，无法恢复。`,
      danger: true,
      confirmText: "清空",
    });
    if (ok) {
      await fs.emptyTrash();
      dlg.toast("回收站已清空");
    }
  };

  const onKey = (e: React.KeyboardEvent) => {
    const n = fs.get(selected);
    if (!n) return;
    if (e.key === "Enter") open(n);
    if (e.key === "F2") void act.rename(n);
    if (e.key === "Delete") void (inTrash ? act.destroy(n) : act.trash(n));
  };

  const sidebar: { label: string; id: number | null; icon: string }[] = [
    { label: "云盘", id: null, icon: "💻" },
    ...fs.children(null).map((n) => ({ label: n.name, id: n.id, icon: nodeIcon(n.name, n.kind, true) })),
  ];

  const crumbs: { label: string; id: number | null }[] = [{ label: "云盘", id: null }];
  {
    const chain: FsNode[] = [];
    let c = current;
    while (c) {
      chain.unshift(c);
      c = fs.get(c.parentId);
    }
    chain.forEach((n) => crumbs.push({ label: n.name, id: n.id }));
  }

  const btn =
    "grid h-7 w-7 place-items-center rounded-md text-base hover:bg-white/10 disabled:opacity-30 disabled:hover:bg-transparent";

  return (
    <div className="flex h-full flex-col @container" onKeyDown={onKey} tabIndex={-1}>
      <div className="flex items-center gap-1 border-b border-white/10 bg-white/[0.03] px-2 py-1.5">
        <button className={btn} onClick={back} disabled={!canBack} title="后退">
          ←
        </button>
        <button className={btn} onClick={forward} disabled={!canForward} title="前进">
          →
        </button>
        <button className={btn} onClick={up} disabled={folderId === null} title="上一级">
          ↑
        </button>
        <div className="mx-1 flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto rounded-md border border-white/10 bg-black/20 px-2 py-1 text-xs whitespace-nowrap">
          {crumbs.map((c, i) => (
            <span key={i} className="flex items-center">
              {i > 0 && <span className="px-1 text-slate-500">›</span>}
              <button className="rounded px-1 hover:bg-white/10" onClick={() => goto(c.id)}>
                {c.label}
              </button>
            </span>
          ))}
        </div>
        {folderId !== null && !inTrash && (
          <>
            <button
              className="rounded-md px-2 py-1 text-xs hover:bg-white/10"
              onClick={() => void act.newItem(folderId, "folder")}
            >
              ＋ 文件夹
            </button>
            <button
              className="rounded-md px-2 py-1 text-xs hover:bg-white/10"
              onClick={() => void act.newItem(folderId, "file")}
            >
              ＋ 文件
            </button>
          </>
        )}
        {inTrash && folderId === fs.trashId && (
          <button
            className="rounded-md px-2 py-1 text-xs text-red-300 hover:bg-red-500/20"
            onClick={() => void emptyTrash()}
          >
            清空回收站
          </button>
        )}
      </div>

      <div className="flex min-h-0 flex-1">
        <nav className="hidden w-40 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-white/10 p-2 text-sm @lg:flex">
          {sidebar.map((s) => {
            const target = s.id === null ? undefined : fs.get(s.id);
            return (
              <button
                key={s.label}
                onClick={() => goto(s.id)}
                {...act.dropProps(target)}
                className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-white/10 ${
                  folderId === s.id ? "bg-white/10 text-[var(--accent)]" : ""
                }`}
              >
                <span>{s.icon}</span>
                <span className="truncate">{s.label}</span>
              </button>
            );
          })}
        </nav>

        <div
          className="min-w-0 flex-1 overflow-y-auto p-3"
          onClick={() => setSelected(null)}
          onContextMenu={blankMenu}
        >
          {items.length === 0 ? (
            <div className="grid h-full min-h-40 place-items-center text-sm text-slate-500">
              {inTrash ? "回收站是空的" : "此文件夹为空，右键可新建"}
            </div>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(5.5rem,1fr))] gap-1">
              {items.map((n) => (
                <button
                  key={n.id}
                  {...act.dragProps(n)}
                  {...act.dropProps(n)}
                  onClick={(e) => {
                    e.stopPropagation();
                    setSelected(n.id);
                    if (wm.isMobile) open(n);
                  }}
                  onDoubleClick={() => open(n)}
                  onContextMenu={(e) => {
                    setSelected(n.id);
                    menu.show(e, act.menuFor(n, (f) => goto(f.id)));
                  }}
                  className={`flex flex-col items-center gap-1 rounded-lg border p-2 text-center ${
                    selected === n.id
                      ? "border-[var(--accent)]/60 bg-[var(--accent)]/20"
                      : "border-transparent hover:bg-white/8"
                  }`}
                >
                  <span className="text-4xl leading-none">
                    {nodeIcon(n.name, n.kind, n.parentId === null)}
                  </span>
                  <span className="line-clamp-2 w-full break-all text-xs leading-tight">
                    {n.name}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="flex items-center justify-between border-t border-white/10 px-3 py-1 text-xs text-slate-400">
        <span>{items.length} 个项目</span>
        <span className="truncate pl-2">{fs.pathOf(folderId)}</span>
      </div>
    </div>
  );
}
