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

export const SYS_DRAG_KEY = "application/x-sys-path";

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
  write: (path: string, content: string, expectedContent?: string) =>
    call("/api/sys/fs", { method: "PUT", body: json({ path, content, expectedContent }) }),
  rename: (path: string, name: string) =>
    call<{ path: string }>("/api/sys/fs", { method: "PATCH", body: json({ path, name }) }),
  move: (path: string, moveTo: string) =>
    call<{ path: string }>("/api/sys/fs", { method: "PATCH", body: json({ path, moveTo }) }),
  restore: (path: string) =>
    call("/api/sys/fs", { method: "PATCH", body: json({ path, restore: true }) }),
  trash: (path: string) => call(`/api/sys/fs?path=${q(path)}`, { method: "DELETE" }),
  destroy: (path: string) => call(`/api/sys/fs?path=${q(path)}&permanent=1`, { method: "DELETE" }),
  emptyTrash: () => call("/api/sys/fs?emptyTrash=1", { method: "DELETE" }),
  kill: (pid: number, signal: string) =>
    call("/api/sys/kill", { method: "POST", body: json({ pid, signal }) }),
};

export const rawUrl = (p: string, download = false) =>
  `/api/sys/raw?path=${q(p)}${download ? "&download=1" : ""}`;

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
  const bump = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    let alive = true;
    call<SysInfoLite>("/api/sys/info?lite=1")
      .then((i) => alive && setInfo(i))
      .catch(() => {})
      .finally(() => alive && setReady(true));
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const refresh = () => bump();
    window.addEventListener("wd:refresh", refresh);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("wd:refresh", refresh);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [bump]);

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
    () => ({ ready, info, desktopItems, version, bump }),
    [ready, info, desktopItems, version, bump],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

// 带错误提示的真实文件操作
export function useSysOps() {
  const dlg = useDialogs();
  const { bump } = useSys();

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
      save: (path: string, content: string, expectedContent?: string) => run(() => sysApi.write(path, content, expectedContent)),
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
  }, [dlg, bump]);
}

// 应用图标（按图标名或绝对路径，由服务器在系统图标主题里查找）
export const guiIconUrl = (name: string) => `/api/gui/icon?name=${encodeURIComponent(name)}`;
