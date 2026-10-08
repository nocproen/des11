"use client";

import { useRef, type PointerEvent as RPointerEvent } from "react";
import { CalculatorApp } from "./apps/calculator-app";
import { FilesApp } from "./apps/files-app";
import { NotepadApp } from "./apps/notepad-app";
import { SettingsApp } from "./apps/settings-app";
import { TerminalApp } from "./apps/terminal-app";
import { AppIcon } from "./app-icon";
import { BrowserApp } from "./apps/browser-app";
import { GuiApp } from "./apps/gui-app";
import { MonitorApp } from "./apps/monitor-app";
import { SysEditApp } from "./apps/sysedit-app";
import { SysFilesApp } from "./apps/sysfiles-app";
import { SysTermApp } from "./apps/systerm-app";
import { baseName, useSys } from "./sys-store";
import { nodeIcon } from "./defs";
import { useFs } from "./fs-store";
import { APPS, useWm, type Win } from "./wm-store";

const MIN_W = 300;
const MIN_H = 200;

const HANDLES = [
  { k: "n", cls: "left-2 right-2 top-0 h-1.5 cursor-n-resize", n: 1, s: 0, e: 0, w: 0 },
  { k: "s", cls: "left-2 right-2 bottom-0 h-1.5 cursor-s-resize", n: 0, s: 1, e: 0, w: 0 },
  { k: "e", cls: "top-2 bottom-2 right-0 w-1.5 cursor-e-resize", n: 0, s: 0, e: 1, w: 0 },
  { k: "w", cls: "top-2 bottom-2 left-0 w-1.5 cursor-w-resize", n: 0, s: 0, e: 0, w: 1 },
  { k: "ne", cls: "right-0 top-0 h-4 w-4 cursor-ne-resize", n: 1, s: 0, e: 1, w: 0 },
  { k: "nw", cls: "left-0 top-0 h-4 w-4 cursor-nw-resize", n: 1, s: 0, e: 0, w: 1 },
  { k: "se", cls: "bottom-0 right-0 h-4 w-4 cursor-se-resize", n: 0, s: 1, e: 1, w: 0 },
  { k: "sw", cls: "bottom-0 left-0 h-4 w-4 cursor-sw-resize", n: 0, s: 1, e: 0, w: 1 },
];

export function AppWindow({ win }: { win: Win }) {
  const wm = useWm();
  const fs = useFs();
  const { info } = useSys();
  const focused = wm.focusedId === win.id;
  const full = win.maximized || wm.isMobile;
  const drag = useRef<{ px: number; py: number; x: number; y: number } | null>(null);

  const def = APPS[win.app];
  let title = def.name;
  let icon = def.icon;
  if (win.app === "files") {
    const f = fs.get(win.folderId);
    title = f ? (f.parentId === null && f.name === "Trash" ? "回收站" : f.name) : "云盘";
    icon = f ? nodeIcon(f.name, f.kind, f.parentId === null) : "💻";
  } else if (win.app === "notepad") {
    const f = fs.get(win.fileId);
    title = f ? f.name : "无标题";
  } else if (win.app === "sysfiles") {
    const p = win.path ?? "~";
    title = p === "~" || p === info?.home ? "主目录" : p === info?.trash ? "回收站" : baseName(p);
    icon = p === info?.trash ? "🗑️" : p === "/" ? "💽" : "📂";
  } else if (win.app === "sysedit") {
    title = baseName(win.path ?? "") || "无标题";
  } else if (win.app === "systerm") {
    title = win.path ? `终端 — ${baseName(win.path)}` : "终端";
  }

  if ((win.app === "lite" || win.app === "gui") && win.title) title = win.title;

  const onDragStart = (e: RPointerEvent) => {
    if ((e.target as HTMLElement).closest("button") || full) return;
    drag.current = { px: e.clientX, py: e.clientY, x: win.x, y: win.y };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onDragMove = (e: RPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const maxY = window.innerHeight - 56 - 40;
    wm.patch(win.id, {
      x: Math.max(-win.w + 120, Math.min(d.x + e.clientX - d.px, window.innerWidth - 100)),
      y: Math.max(0, Math.min(d.y + e.clientY - d.py, maxY)),
    });
  };
  const onDragEnd = () => {
    drag.current = null;
  };

  const startResize = (h: (typeof HANDLES)[number]) => (e: RPointerEvent) => {
    if (full) return;
    e.stopPropagation();
    e.preventDefault();
    const start = { px: e.clientX, py: e.clientY, x: win.x, y: win.y, w: win.w, h: win.h };
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - start.px;
      const dy = ev.clientY - start.py;
      let { x, y, w, h: hh } = start;
      if (h.e) w = Math.max(MIN_W, start.w + dx);
      if (h.s) hh = Math.max(MIN_H, start.h + dy);
      if (h.w) {
        w = Math.max(MIN_W, start.w - dx);
        x = start.x + (start.w - w);
      }
      if (h.n) {
        hh = Math.max(MIN_H, start.h - dy);
        y = Math.max(0, start.y + (start.h - hh));
        hh = start.h + (start.y - y);
      }
      wm.patch(win.id, { x, y, w, h: hh });
    };
    const up = () => {
      target.removeEventListener("pointermove", move as EventListener);
      target.removeEventListener("pointerup", up);
      target.removeEventListener("pointercancel", up);
    };
    target.addEventListener("pointermove", move as EventListener);
    target.addEventListener("pointerup", up);
    target.addEventListener("pointercancel", up);
  };

  return (
    <div
      onPointerDown={() => !focused && wm.focus(win.id)}
      style={
        full
          ? { zIndex: win.z, display: win.minimized ? "none" : undefined }
          : {
              left: win.x,
              top: win.y,
              width: win.w,
              height: win.h,
              zIndex: win.z,
              display: win.minimized ? "none" : undefined,
            }
      }
      className={`absolute flex flex-col overflow-hidden border text-slate-100 ${
        full ? "inset-0 rounded-none" : "rounded-xl"
      } ${
        focused
          ? "border-white/20 bg-[#1e293b] shadow-[0_20px_60px_rgba(0,0,0,0.55)]"
          : "border-white/10 bg-[#19222f] shadow-[0_10px_30px_rgba(0,0,0,0.35)]"
      } animate-[pop_0.15s_ease-out]`}
    >
      <div
        onPointerDown={onDragStart}
        onPointerMove={onDragMove}
        onPointerUp={onDragEnd}
        onPointerCancel={onDragEnd}
        onDoubleClick={(e) => {
          if (!(e.target as HTMLElement).closest("button") && !wm.isMobile) wm.toggleMax(win.id);
        }}
        className={`flex h-10 shrink-0 touch-none select-none items-center gap-2 px-3 ${
          focused ? "bg-white/[0.07]" : "bg-white/[0.02]"
        }`}
      >
        <span className="grid h-5 w-5 shrink-0 place-items-center">
          <AppIcon url={win.iconUrl} fallback={icon} size={20} />
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{title}</span>
        <button
          onClick={() => wm.minimize(win.id)}
          className="grid h-7 w-8 place-items-center rounded-md text-slate-300 hover:bg-white/10"
          aria-label="最小化"
        >
          <span className="mb-0.5 block h-px w-3 bg-current" />
        </button>
        {!wm.isMobile && (
          <button
            onClick={() => wm.toggleMax(win.id)}
            className="grid h-7 w-8 place-items-center rounded-md text-slate-300 hover:bg-white/10"
            aria-label="最大化"
          >
            {win.maximized ? (
              <span className="relative block h-3 w-3">
                <span className="absolute right-0 top-0 h-2 w-2 border border-current" />
                <span className="absolute bottom-0 left-0 h-2 w-2 border border-current bg-slate-800" />
              </span>
            ) : (
              <span className="block h-3 w-3 border border-current" />
            )}
          </button>
        )}
        <button
          onClick={() => wm.close(win.id)}
          className="grid h-7 w-8 place-items-center rounded-md text-slate-300 hover:bg-red-500 hover:text-white"
          aria-label="关闭"
        >
          ✕
        </button>
      </div>

      <div className="relative min-h-0 flex-1">
        {win.app === "files" && <FilesApp win={win} />}
        {win.app === "notepad" && <NotepadApp win={win} />}
        {win.app === "sysfiles" && <SysFilesApp win={win} />}
        {win.app === "sysedit" && <SysEditApp win={win} />}
        {win.app === "systerm" && <SysTermApp win={win} />}
        {win.app === "monitor" && <MonitorApp />}
        {win.app === "lite" && <BrowserApp win={win} />}
        {(win.app === "gui" || win.app === "browser") && <GuiApp win={win} />}
        {win.app === "terminal" && <TerminalApp win={win} />}
        {win.app === "settings" && <SettingsApp />}
        {win.app === "calculator" && <CalculatorApp />}
        {!focused && <div className="absolute inset-0" onPointerDown={() => wm.focus(win.id)} />}
      </div>

      {!full &&
        HANDLES.map((h) => (
          <div
            key={h.k}
            onPointerDown={startResize(h)}
            className={`absolute z-10 touch-none ${h.cls}`}
          />
        ))}
    </div>
  );
}
