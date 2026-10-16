"use client";

import { useEffect, useState, type CSSProperties, type DragEvent } from "react";
import { ContextMenuProvider, useContextMenu } from "./context-menu";
import { DialogProvider, useDialogs } from "./dialogs";
import { AppIcon } from "./app-icon";
import { accentColor, nodeIcon, wallpaperCss } from "./defs";
import { entryExtraMenu, isDesktopFile, openEntry as openEntryWith } from "./open-entry";
import { FsProvider, useFs } from "./fs-store";
import { PasteProvider, usePaste } from "./paste";
import { allowDragOut, copyImage, downloadEntry, isImage } from "./export-file";
import {
  SYS_DRAG_KEY,
  SysProvider,
  baseName,
  guiIconUrl,
  useSys,
  useSysOps,
  type SysEntry,
} from "./sys-store";
import { StartMenu, Taskbar } from "./taskbar";
import { WmProvider, useWm, type AppId } from "./wm-store";
import { AppWindow } from "./window";

// 写进本机剪贴板；剪贴板接口不可用（非 https、没权限）时退回到老办法
async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssText = "position:fixed;opacity:0;left:-9999px";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}

type DesktopIcon =
  | { key: string; kind: "app"; app: AppId; label: string; icon: string; path?: string; folderId?: number | null }
  | { key: string; kind: "trash"; label: string; icon: string }
  | { key: string; kind: "entry"; entry: SysEntry; label: string; icon: string; iconUrl?: string };

function Shell() {
  const fs = useFs();
  const wm = useWm();
  const menu = useContextMenu();
  const ops = useSysOps();
  const paste = usePaste();
  const dlg = useDialogs();
  const { info, desktopItems, bump, clip } = useSys();
  const [startOpen, setStartOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);

  const desktopDir = info?.desktop ?? "";

  // 桌面上的 .desktop 启动文件：读取应用名称和图标
  const [launchers, setLaunchers] = useState<Record<string, { name: string; icon: string }>>({});
  const launcherKey = desktopItems.filter((e) => isDesktopFile(e.name)).map((e) => e.path).join("|");
  useEffect(() => {
    if (!launcherKey) {
      setLaunchers({});
      return;
    }
    let alive = true;
    fetch("/api/gui/apps", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { desktop: [] }))
      .then((d: { desktop: { file: string; name: string; icon: string }[] }) => {
        if (alive) setLaunchers(Object.fromEntries((d.desktop ?? []).map((x) => [x.file, { name: x.name, icon: x.icon }])));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [launcherKey]);

  const icons: DesktopIcon[] = [
    { key: "home", kind: "app", app: "sysfiles", label: "主目录", icon: "🏠", path: "~" },
    { key: "root", kind: "app", app: "sysfiles", label: "文件系统", icon: "💽", path: "/" },
    { key: "browser", kind: "app", app: "browser", label: "浏览器", icon: "🌐" },
    { key: "lite", kind: "app", app: "lite", label: "极速浏览器", icon: "⚡" },
    { key: "term", kind: "app", app: "systerm", label: "终端", icon: "⌨️" },
    { key: "monitor", kind: "app", app: "monitor", label: "系统监视器", icon: "📊" },
    { key: "cloud", kind: "app", app: "files", label: "云盘", icon: "☁️", folderId: null },
    { key: "settings", kind: "app", app: "settings", label: "设置", icon: "⚙️" },
    { key: "trash", kind: "trash", label: "回收站", icon: "🗑️" },
    ...desktopItems.map<DesktopIcon>((e) => ({
      key: `e:${e.path}`,
      kind: "entry",
      entry: e,
      label: launchers[e.path]?.name ?? (isDesktopFile(e.name) ? e.name.replace(/\.desktop$/i, "") : e.name),
      icon: e.kind === "folder" ? "📁" : isDesktopFile(e.name) ? "🚀" : nodeIcon(e.name, "file"),
      iconUrl: launchers[e.path]?.icon ? guiIconUrl(launchers[e.path].icon) : undefined,
    })),
  ];

  const openEntry = (e: SysEntry) => {
    const l = launchers[e.path];
    openEntryWith(wm, e, l ? { name: l.name, iconUrl: l.icon ? guiIconUrl(l.icon) : undefined } : undefined);
  };

  const openIcon = (i: DesktopIcon) => {
    setSelected(i.key);
    if (i.kind === "app") {
      wm.open(i.app, {
        ...(i.path !== undefined ? { path: i.path } : {}),
        ...(i.folderId !== undefined ? { folderId: i.folderId } : {}),
      });
    } else if (i.kind === "trash") wm.open("sysfiles", { path: info?.trash ?? "~" });
    else openEntry(i.entry);
  };

  const copyEntryItem = (en: SysEntry, cut = false) => {
    void ops.copy(en.path, cut);
    if (!cut && isImage(en.name) && en.kind === "file") {
      void copyImage(en.path).catch(() => {});
    }
  };

  const iconMenu = (e: React.MouseEvent, i: DesktopIcon) => {
    setSelected(i.key);
    if (i.kind === "entry") {
      const en = i.entry;
      return menu.show(e, [
        { label: "打开", icon: "📂", onClick: () => openEntry(en) },
        ...entryExtraMenu(wm, en),
        { label: "复制（可粘贴到 VNC / 文件夹）", icon: "📋", onClick: () => copyEntryItem(en, false) },
        { label: "剪切", icon: "✂️", onClick: () => copyEntryItem(en, true) },
        ...(en.kind === "folder"
          ? [{ label: "粘贴到此文件夹", icon: "📥", onClick: () => paste.paste(en.path) }]
          : []),
        {
          label: "在终端中打开",
          icon: "⌨️",
          onClick: () => wm.open("systerm", { path: en.kind === "folder" ? en.path : desktopDir }),
        },
        { label: "重命名", icon: "✏️", onClick: () => void ops.renameDialog(en.path) },
        { label: "下载到电脑", icon: "⬇️", onClick: () => downloadEntry(en) },
        ...(isImage(en.name) && en.kind === "file"
          ? [
              {
                label: "复制图片（同步 VNC 与本机）",
                icon: "🖼️",
                onClick: () => {
                  void ops.copy(en.path, false);
                  void copyImage(en.path).catch(() => {});
                },
              },
            ]
          : []),
        { label: "复制路径", icon: "🔗", onClick: () => void copyText(en.path).then((ok) => dlg.toast(ok ? `已复制：${en.path}` : "复制失败，浏览器不允许访问剪贴板")) },
        { divider: true },
        { label: "移到回收站", icon: "🗑️", danger: true, onClick: () => void ops.trash(en.path) },
      ]);
    }
    if (i.kind === "trash") {
      return menu.show(e, [
        { label: "打开", icon: "📂", onClick: () => openIcon(i) },
        { label: "清空回收站", icon: "🗑️", danger: true, onClick: () => void ops.emptyTrash() },
      ]);
    }
    menu.show(e, [{ label: "打开", icon: "📂", onClick: () => openIcon(i) }]);
  };

  const desktopMenu = (e: React.MouseEvent) =>
    menu.show(e, [
      { label: "新建文件夹", icon: "📁", onClick: () => void ops.newItem(desktopDir, "folder") },
      { label: "新建文本文档", icon: "📄", onClick: () => void ops.newItem(desktopDir, "file") },
      {
        label: clip?.paths.length ? `粘贴「${baseName(clip.paths[0])}」` : "粘贴",
        icon: "📋",
        disabled: !desktopDir,
        onClick: () => paste.paste(desktopDir),
      },
      ...(clip?.paths.length
        ? [{ label: "从本地电脑粘贴文件…", icon: "📥", disabled: !desktopDir, onClick: () => paste.pasteLocal(desktopDir) }]
        : []),
      { divider: true },
      { label: "在此处打开终端", icon: "⌨️", onClick: () => wm.open("systerm", { path: desktopDir }) },
      { label: "打开桌面文件夹", icon: "📂", onClick: () => wm.open("sysfiles", { path: desktopDir }) },
      { label: "更换壁纸 / 个性化", icon: "🎨", onClick: () => wm.open("settings") },
      { divider: true },
      { label: "刷新", icon: "🔄", onClick: () => { bump(); void fs.reload(); } },
    ]);

  const onDesktopKeyDown = (e: React.KeyboardEvent) => {
    const selIcon = icons.find((x) => x.key === selected);
    if (!selIcon || selIcon.kind !== "entry") return;
    const en = selIcon.entry;
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
      const k = e.key.toLowerCase();
      if (k === "c") {
        e.preventDefault();
        copyEntryItem(en, false);
        return;
      }
      if (k === "x") {
        e.preventDefault();
        copyEntryItem(en, true);
        return;
      }
    }
    if (e.key === "Enter") openEntry(en);
    else if (e.key === "F2") void ops.renameDialog(en.path);
    else if (e.key === "Delete") void ops.trash(en.path);
  };

  // 拖拽到桌面 / 文件夹图标 / 回收站，真实移动服务器上的文件；从 Windows 拖进来的文件则上传（回收站除外）
  const acceptDrop = (target: string, trash = false) => ({
    onDragOver: (e: DragEvent) => {
      if (e.dataTransfer.types.includes(SYS_DRAG_KEY)) {
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "move";
      } else if (!trash) paste.fileDrop(target).onDragOver(e);
    },
    onDrop: async (e: DragEvent) => {
      const src = e.dataTransfer.getData(SYS_DRAG_KEY);
      if (!src) {
        if (!trash) paste.fileDrop(target).onDrop(e);
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      if (src === target) return;
      if (trash) await ops.trash(src);
      else await ops.move(src, target);
    },
  });

  const style = {
    "--accent": accentColor(fs.settings),
    background: wallpaperCss(fs.settings),
  } as CSSProperties;

  return (
    <div
      // overflow-clip 而不是 hidden：hidden 的容器仍会被 focus() / scrollIntoView 滚动，整个桌面（连同任务栏）就被推上去了。
      // clip 禁止任何滚动；onScroll 兜底，万一还是滚了就立刻复位
      className="fixed inset-0 select-none overflow-clip"
      onScroll={(e) => {
        const el = e.currentTarget;
        if (el.scrollTop || el.scrollLeft) el.scrollTo(0, 0);
      }}
      style={style}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div
        className="absolute inset-x-0 top-0 bottom-14 p-2 outline-none"
        tabIndex={-1}
        data-paste-dir={desktopDir || undefined}
        onKeyDown={onDesktopKeyDown}
        onClick={() => {
          setSelected(null);
          setStartOpen(false);
        }}
        onContextMenu={desktopMenu}
        {...(desktopDir ? acceptDrop(desktopDir) : {})}
      >
        <div className="grid h-full auto-cols-[5.75rem] grid-flow-col grid-rows-[repeat(auto-fill,6.25rem)] content-start justify-start gap-1">
          {icons.map((i) => (
            <button
              key={i.key}
              {...(i.kind === "entry"
                ? {
                    draggable: true,
                    onDragStart: (e: DragEvent) => {
                      e.dataTransfer.setData(SYS_DRAG_KEY, i.entry.path);
                      allowDragOut(e, i.entry); // 也可以直接拖到 Windows 桌面 / 资源管理器
                    },
                  }
                : {})}
              {...(i.kind === "trash" && info ? acceptDrop(info.trash, true) : {})}
              {...(i.kind === "entry" && i.entry.kind === "folder" ? acceptDrop(i.entry.path) : {})}
              onClick={(e) => {
                e.stopPropagation();
                setStartOpen(false);
                setSelected(i.key);
                if (wm.isMobile) openIcon(i);
              }}
              onDoubleClick={() => openIcon(i)}
              onContextMenu={(e) => iconMenu(e, i)}
              className={`flex h-[6.25rem] w-[5.75rem] flex-col items-center gap-1 rounded-lg border p-1.5 text-white ${
                selected === i.key
                  ? "border-white/30 bg-white/20"
                  : "border-transparent hover:bg-white/10"
              }`}
            >
              <AppIcon url={"iconUrl" in i ? i.iconUrl : undefined} fallback={i.icon} size={40} />
              <span className="line-clamp-2 w-full break-all text-xs leading-tight [text-shadow:0_1px_3px_rgba(0,0,0,0.9)]">
                {i.label}
              </span>
            </button>
          ))}
        </div>
      </div>

      <div className="pointer-events-none absolute inset-x-0 top-0 bottom-14">
        <div className="pointer-events-none relative h-full w-full [&>*]:pointer-events-auto">
          {wm.wins.map((w) => (
            <AppWindow key={w.id} win={w} />
          ))}
        </div>
      </div>

      {startOpen && <StartMenu onClose={() => setStartOpen(false)} />}
      <Taskbar startOpen={startOpen} setStartOpen={setStartOpen} />
    </div>
  );
}

function Boot() {
  const fs = useFs();
  const sys = useSys();
  const [minDone, setMinDone] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setMinDone(true), 900);
    return () => clearTimeout(t);
  }, []);

  if (fs.ready && sys.ready && minDone) return <Shell />;

  return (
    <div className="fixed inset-0 grid place-items-center bg-slate-950 text-white">
      <div className="flex flex-col items-center gap-6">
        <div className="grid grid-cols-2 gap-1.5">
          {[0, 1, 2, 3].map((i) => (
            <span
              key={i}
              className="h-8 w-8 animate-pulse rounded-md bg-sky-400"
              style={{ animationDelay: `${i * 150}ms` }}
            />
          ))}
        </div>
        <div className="text-lg font-light tracking-[0.3em]">WEBDESKTOP</div>
        <div className="text-xs text-slate-500">正在连接系统…</div>
      </div>
    </div>
  );
}

export default function Desktop() {
  return (
    <DialogProvider>
      <FsProvider>
        <SysProvider>
          <WmProvider>
            <ContextMenuProvider>
              <PasteProvider>
                <Boot />
              </PasteProvider>
            </ContextMenuProvider>
          </WmProvider>
        </SysProvider>
      </FsProvider>
    </DialogProvider>
  );
}
