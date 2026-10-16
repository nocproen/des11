"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useDialogs } from "./dialogs";
import { withDesktopAccess } from "./client-session";

export type SysEntry = {
  name: string;
  path: string;
  kind: "folder" | "file";
  link: boolean;
  size: number;
  mtime: number;
  mode: string;
  hidden: boolean;
};

export type SysInfoLite = {
  user: string;
  host: string;
  home: string;
  desktop: string;
  documents: string;
  downloads: string;
  pictures: string;
  trash: string;
  os: string;
};

export type SysClip = {
  paths: string[];
  cut: boolean;
  ts: number;
};

export const SYS_DRAG_KEY = "application/x-sys-path";
export const SYS_CLIP_STORAGE_KEY = "wd_sys_clip";

export function readStoredSysClip(): SysClip | null {
  try {
    const raw = localStorage.getItem(SYS_CLIP_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SysClip;
    if (Array.isArray(parsed?.paths) && parsed.paths.length > 0) return parsed;
  } catch {
    /* ignore */
  }
  return null;
}

export function writeStoredSysClip(clip: SysClip | null) {
  try {
    if (clip && clip.paths.length) {
      localStorage.setItem(SYS_CLIP_STORAGE_KEY, JSON.stringify(clip));
    } else {
      localStorage.removeItem(SYS_CLIP_STORAGE_KEY);
    }
  } catch {
    /* ignore */
  }
}

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
  });
  const data = (await r.json().catch(() => ({}))) as { error?: string };
  if (!r.ok) throw new Error(data.error ?? "请求失败");
  return data as T;
}

const q = encodeURIComponent;
const json = (o: object) => JSON.stringify(o);

export type SysFile = {
  path: string;
  name: string;
  size: number;
  mtime: number;
  tooLarge: boolean;
  binary: boolean;
  content: string;
};

export const sysApi = {
  list: (p: string, hidden = true) =>
    call<{ path: string; parent: string | null; entries: SysEntry[] }>(
      `/api/sys/fs?path=${q(p)}&hidden=${hidden ? 1 : 0}`,
    ),
  read: (p: string) => call<SysFile>(`/api/sys/fs?path=${q(p)}&read=1`),
  create: (dir: string, name: string, kind: "file" | "folder", content = "") =>
    call<{ path: string }>("/api/sys/fs", { method: "POST", body: json({ dir, name, kind, content }) }),
  write: (path: string, content: string) =>
    call("/api/sys/fs", { method: "PUT", body: json({ path, content }) }),
  rename: (path: string, name: string) =>
    call<{ path: string }>("/api/sys/fs", { method: "PATCH", body: json({ path, name }) }),
  move: (path: string, moveTo: string) =>
    call<{ path: string }>("/api/sys/fs", { method: "PATCH", body: json({ path, moveTo }) }),
  copyPaste: (destDir: string, copyPaths?: string[], cut = false, pasteFromVnc = false) =>
    call<{ paths: string[]; count: number; cut: boolean }>("/api/sys/fs", {
      method: "PATCH",
      body: json({ destDir, copyPaths, cut, pasteFromVnc }),
    }),
  syncVncClipboard: (paths: string[], cut = false) =>
    call<{ ok: boolean }>("/api/gui/clipboard", { method: "POST", body: json({ paths, cut }) }),
  restore: (path: string) =>
    call("/api/sys/fs", { method: "PATCH", body: json({ path, restore: true }) }),
  trash: (path: string) => call(`/api/sys/fs?path=${q(path)}`, { method: "DELETE" }),
  destroy: (path: string) => call(`/api/sys/fs?path=${q(path)}&permanent=1`, { method: "DELETE" }),
  emptyTrash: () => call("/api/sys/fs?emptyTrash=1", { method: "DELETE" }),
  kill: (pid: number, signal: string) =>
    call("/api/sys/kill", { method: "POST", body: json({ pid, signal }) }),
};

export const rawUrl = (p: string, download = false) =>
  withDesktopAccess(`/api/sys/raw?path=${q(p)}${download ? "&download=1" : ""}`);

export function baseName(p: string) {
  if (p === "/") return "/";
  return p.replace(/\/+$/, "").split("/").pop() ?? p;
}

export function joinPath(dir: string, name: string) {
  return dir.endsWith("/") ? dir + name : `${dir}/${name}`;
}

export function dirName(p: string) {
  const i = p.replace(/\/+$/, "").lastIndexOf("/");
  return i <= 0 ? "/" : p.slice(0, i);
}

type SysApiCtx = {
  ready: boolean;
  info: SysInfoLite | null;
  desktopItems: SysEntry[];
  version: number;
  bump: () => void;
  clip: SysClip | null;
  setClip: (c: SysClip | null) => void;
};

const Ctx = createContext<SysApiCtx | null>(null);

export function useSys() {
  const v = useContext(Ctx);
  if (!v) throw new Error("SysProvider missing");
  return v;
}

export function SysProvider({ children }: { children: ReactNode }) {
  const [info, setInfo] = useState<SysInfoLite | null>(null);
  const [ready, setReady] = useState(false);
  const [desktopItems, setDesktopItems] = useState<SysEntry[]>([]);
  const [version, setVersion] = useState(0);
  const [clip, setClipState] = useState<SysClip | null>(null);
  const bump = useCallback(() => setVersion((v) => v + 1), []);

  const setClip = useCallback((next: SysClip | null) => {
    setClipState(next);
    writeStoredSysClip(next);
  }, []);

  useEffect(() => {
    const initialClip = readStoredSysClip();
    if (initialClip) {
      setClipState(initialClip);
      void sysApi.syncVncClipboard(initialClip.paths, initialClip.cut).catch(() => {});
    }
    let alive = true;
    call<SysInfoLite>("/api/sys/info?lite=1")
      .then((i) => alive && setInfo(i))
      .catch(() => {})
      .finally(() => alive && setReady(true));
    return () => {
      alive = false;
    };
  }, []);

  // 桌面 = 服务器上真实的 ~/Desktop 目录，定时同步
  const desktop = info?.desktop;
  useEffect(() => {
    if (!desktop) return;
    let alive = true;
    const load = () => {
      if (document.hidden) return;
      sysApi
        .list(desktop, false)
        .then((r) => alive && setDesktopItems(r.entries))
        .catch(() => {});
    };
    load();
    const t = setInterval(load, 3000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [desktop, version]);

  const value = useMemo(
    () => ({ ready, info, desktopItems, version, bump, clip, setClip }),
    [ready, info, desktopItems, version, bump, clip, setClip],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

// 带错误提示的真实文件操作
export function useSysOps() {
  const dlg = useDialogs();
  const { bump, clip, setClip } = useSys();

  return useMemo(() => {
    const run = async <T,>(fn: () => Promise<T>): Promise<T | null> => {
      try {
        const r = await fn();
        bump();
        return r;
      } catch (e) {
        dlg.toast(e instanceof Error ? e.message : "操作失败");
        return null;
      }
    };
    return {
      create: (dir: string, name: string, kind: "file" | "folder", content = "") =>
        run(() => sysApi.create(dir, name, kind, content)),
      rename: (path: string, name: string) => run(() => sysApi.rename(path, name)),
      move: (path: string, dest: string) => run(() => sysApi.move(path, dest)),
      copy: async (target: string | string[], cut = false) => {
        const paths = (Array.isArray(target) ? target : [target]).filter(Boolean);
        if (!paths.length) return false;
        const next: SysClip = { paths, cut, ts: Date.now() };
        setClip(next);
        try {
          await sysApi.syncVncClipboard(paths, cut);
          const label = paths.length === 1 ? `「${baseName(paths[0])}」` : `${paths.length} 个项目`;
          dlg.toast(
            cut
              ? `已剪切 ${label}（可在文件夹或 VNC 应用中粘贴）`
              : `已复制 ${label}（可直接粘贴到 VNC 应用或文件夹）`,
          );
          return true;
        } catch (e) {
          dlg.toast(e instanceof Error ? e.message : "复制失败");
          return false;
        }
      },
      pasteFiles: async (destDir: string, pasteFromVnc = false) => {
        if (!pasteFromVnc && (!clip || !clip.paths.length)) return false;
        const r = await run(() =>
          sysApi.copyPaste(
            destDir,
            pasteFromVnc ? undefined : clip?.paths,
            pasteFromVnc ? false : !!clip?.cut,
            pasteFromVnc,
          ),
        );
        if (!r) return false;
        if (!pasteFromVnc && clip?.cut) setClip(null);
        const where = baseName(destDir);
        dlg.toast(
          r.count === 1
            ? `已粘贴「${baseName(r.paths[0])}」到 ${where}`
            : `已粘贴 ${r.count} 个项目到 ${where}`,
        );
        return true;
      },
      trash: async (path: string) => {
        const r = await run(() => sysApi.trash(path));
        if (r) dlg.toast("已移到回收站");
        return !!r;
      },
      restore: async (path: string) => {
        const r = await run(() => sysApi.restore(path));
        if (r) dlg.toast("已还原");
        return !!r;
      },
      destroy: async (path: string) => {
        const name = baseName(path);
        const ok = await dlg.confirm({
          title: "永久删除",
          message: `确定要永久删除「${name}」吗？这会真实删除服务器上的文件，无法恢复。`,
          danger: true,
          confirmText: "永久删除",
        });
        if (!ok) return false;
        return !!(await run(() => sysApi.destroy(path)));
      },
      emptyTrash: async () => {
        const ok = await dlg.confirm({
          title: "清空回收站",
          message: "将永久删除回收站里的所有项目，无法恢复。",
          danger: true,
          confirmText: "清空",
        });
        if (!ok) return false;
        const r = await run(() => sysApi.emptyTrash());
        if (r) dlg.toast("回收站已清空");
        return !!r;
      },
      save: (path: string, content: string) => run(() => sysApi.write(path, content)),
      newItem: async (dir: string, kind: "file" | "folder") => {
        const name = await dlg.prompt({
          title: kind === "folder" ? "新建文件夹" : "新建文本文档",
          value: kind === "folder" ? "新建文件夹" : "新建文本文档.txt",
          confirmText: "创建",
        });
        if (!name?.trim()) return null;
        return run(() => sysApi.create(dir, name.trim(), kind));
      },
      renameDialog: async (path: string) => {
        const old = baseName(path);
        const name = await dlg.prompt({ title: "重命名", value: old });
        if (!name?.trim() || name === old) return null;
        return run(() => sysApi.rename(path, name.trim()));
      },
    };
  }, [dlg, bump, clip, setClip]);
}

// 应用图标（按图标名或绝对路径，由服务器在系统图标主题里查找）
export const guiIconUrl = (name: string) => withDesktopAccess(`/api/gui/icon?name=${encodeURIComponent(name)}`);
