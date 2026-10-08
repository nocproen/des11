"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useDialogs } from "./dialogs";

export type FsNode = {
  id: number;
  parentId: number | null;
  name: string;
  kind: "folder" | "file";
  content: string;
  trashedFrom: number | null;
  createdAt: string;
  updatedAt: string;
};

export type Settings = Record<string, string>;

type FsApi = {
  ready: boolean;
  nodes: FsNode[];
  settings: Settings;
  desktopId: number;
  trashId: number;
  documentsId: number;
  get: (id: number | null | undefined) => FsNode | undefined;
  children: (id: number | null) => FsNode[];
  pathOf: (id: number | null) => string;
  isInTrash: (id: number | null) => boolean;
  resolvePath: (path: string, cwd: number | null) => { node: FsNode | null } | undefined;
  create: (
    parentId: number,
    name: string,
    kind: "folder" | "file",
    content?: string,
  ) => Promise<FsNode | null>;
  rename: (id: number, name: string) => Promise<FsNode | null>;
  save: (id: number, content: string, expectedContent?: string) => Promise<FsNode | null>;
  move: (id: number, parentId: number) => Promise<FsNode | null>;
  trash: (id: number) => Promise<boolean>;
  restore: (id: number) => Promise<boolean>;
  destroy: (id: number) => Promise<boolean>;
  emptyTrash: () => Promise<void>;
  setSetting: (key: string, value: string) => void;
  reload: () => Promise<void>;
  reset: () => Promise<void>;
};

const Ctx = createContext<FsApi | null>(null);

export function useFs() {
  const v = useContext(Ctx);
  if (!v) throw new Error("FsProvider missing");
  return v;
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
  });
  if (!r.ok) {
    const e = (await r.json().catch(() => ({}))) as { error?: string };
    throw new Error(e.error ?? "请求失败");
  }
  return r.json() as Promise<T>;
}

export function sortNodes(list: FsNode[]) {
  return [...list].sort((a, b) =>
    a.kind !== b.kind ? (a.kind === "folder" ? -1 : 1) : a.name.localeCompare(b.name, "zh"),
  );
}

export function FsProvider({ children }: { children: ReactNode }) {
  const { toast } = useDialogs();
  const [nodes, setNodes] = useState<FsNode[]>([]);
  const [settings, setSettings] = useState<Settings>({});
  const [ready, setReady] = useState(false);
  const nodesRef = useRef<FsNode[]>([]);
  const epoch = useRef(0);
  const loading = useRef(false);

  const commit = useCallback((updater: (prev: FsNode[]) => FsNode[]) => {
    epoch.current++;
    const next = updater(nodesRef.current);
    nodesRef.current = next;
    setNodes(next);
  }, []);

  const reload = useCallback(async (silent = false) => {
    if (loading.current) return;
    loading.current = true;
    const started = epoch.current;
    try {
      const data = await api<{ nodes: FsNode[]; settings: Settings }>("/api/fs");
      if (started !== epoch.current) return;
      if (JSON.stringify(nodesRef.current) !== JSON.stringify(data.nodes)) {
        nodesRef.current = data.nodes;
        setNodes(data.nodes);
      }
      setSettings((old) => JSON.stringify(old) === JSON.stringify(data.settings) ? old : data.settings);
      setReady(true);
    } catch (e) {
      if (!silent) toast(e instanceof Error ? e.message : "加载失败");
    } finally { loading.current = false; }
  }, [toast]);

  useEffect(() => {
    void reload();
    const refresh = () => { if (!document.hidden) void reload(true); };
    const poll = setInterval(refresh, 2000);
    window.addEventListener("wd:refresh", refresh);
    window.addEventListener("focus", refresh);
    window.addEventListener("online", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      clearInterval(poll);
      window.removeEventListener("wd:refresh", refresh);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("online", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [reload]);

  const upsert = useCallback(
    (n: FsNode) =>
      commit((prev) =>
        prev.some((x) => x.id === n.id) ? prev.map((x) => (x.id === n.id ? n : x)) : [...prev, n],
      ),
    [commit],
  );

  const guard = useCallback(
    async <T,>(fn: () => Promise<T>, fallback: T): Promise<T> => {
      try {
        return await fn();
      } catch (e) {
        toast(e instanceof Error ? e.message : "操作失败");
        return fallback;
      }
    },
    [toast],
  );

  const get = useCallback(
    (id: number | null | undefined) =>
      id == null ? undefined : nodesRef.current.find((n) => n.id === id),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [nodes],
  );

  const childrenOf = useCallback(
    (id: number | null) => sortNodes(nodesRef.current.filter((n) => n.parentId === id)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [nodes],
  );

  const pathOf = useCallback(
    (id: number | null) => {
      const parts: string[] = [];
      let cur = id == null ? undefined : nodesRef.current.find((n) => n.id === id);
      while (cur) {
        parts.unshift(cur.name);
        const pid: number | null = cur.parentId;
        cur = pid == null ? undefined : nodesRef.current.find((n) => n.id === pid);
      }
      return "/" + parts.join("/");
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [nodes],
  );

  const rootByName = (name: string) =>
    nodes.find((n) => n.parentId === null && n.name === name)?.id ?? -1;
  const desktopId = rootByName("Desktop");
  const trashId = rootByName("Trash");
  const documentsId = rootByName("Documents");

  const isInTrash = useCallback(
    (id: number | null) => {
      let cur = id == null ? undefined : nodesRef.current.find((n) => n.id === id);
      while (cur) {
        if (cur.parentId === null) return cur.name === "Trash";
        const pid: number = cur.parentId;
        cur = nodesRef.current.find((n) => n.id === pid);
      }
      return false;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [nodes],
  );

  const resolvePath = useCallback((path: string, cwd: number | null) => {
    const abs = path.startsWith("/") || path.startsWith("~");
    const parts = path.split("/").filter((p) => p && p !== "~");
    let cur: FsNode | null = abs
      ? null
      : (nodesRef.current.find((n) => n.id === cwd) ?? null);
    for (const part of parts) {
      if (part === ".") continue;
      if (part === "..") {
        cur =
          cur?.parentId == null
            ? null
            : (nodesRef.current.find((n) => n.id === cur!.parentId) ?? null);
        continue;
      }
      if (cur && cur.kind !== "folder") return undefined;
      const parentId: number | null = cur ? cur.id : null;
      const next: FsNode | undefined = nodesRef.current.find(
        (n) => n.parentId === parentId && n.name === part,
      );
      if (!next) return undefined;
      cur = next;
    }
    return { node: cur };
  }, []);

  const create = useCallback<FsApi["create"]>(
    (parentId, name, kind, content = "") =>
      guard(async () => {
        const { node } = await api<{ node: FsNode }>("/api/fs", {
          method: "POST",
          body: JSON.stringify({ parentId, name, kind, content }),
        });
        upsert(node);
        return node;
      }, null),
    [guard, upsert],
  );

  const patch = useCallback(
    (id: number, body: object) =>
      guard(async () => {
        const { node } = await api<{ node: FsNode }>(`/api/fs/${id}`, {
          method: "PATCH",
          body: JSON.stringify(body),
        });
        upsert(node);
        return node;
      }, null),
    [guard, upsert],
  );

  const rename = useCallback((id: number, name: string) => patch(id, { name }), [patch]);
  const save = useCallback((id: number, content: string, expectedContent?: string) => patch(id, { content, expectedContent }), [patch]);
  const move = useCallback((id: number, parentId: number) => patch(id, { parentId }), [patch]);
  const restore = useCallback(async (id: number) => !!(await patch(id, { restore: true })), [patch]);

  const removeLocal = useCallback(
    (id: number) =>
      commit((prev) => {
        const doomed = new Set([id]);
        let grew = true;
        while (grew) {
          grew = false;
          for (const n of prev) {
            if (n.parentId !== null && doomed.has(n.parentId) && !doomed.has(n.id)) {
              doomed.add(n.id);
              grew = true;
            }
          }
        }
        return prev.filter((n) => !doomed.has(n.id));
      }),
    [commit],
  );

  const trash = useCallback(
    (id: number) =>
      guard(async () => {
        const res = await api<{ node?: FsNode; deleted?: boolean }>(`/api/fs/${id}`, {
          method: "DELETE",
        });
        if (res.node) upsert(res.node);
        else removeLocal(id);
        return true;
      }, false),
    [guard, upsert, removeLocal],
  );

  const destroy = useCallback(
    (id: number) =>
      guard(async () => {
        await api(`/api/fs/${id}?permanent=1`, { method: "DELETE" });
        removeLocal(id);
        return true;
      }, false),
    [guard, removeLocal],
  );

  const emptyTrash = useCallback(
    () =>
      guard(async () => {
        await api("/api/fs?trash=1", { method: "DELETE" });
        await reload();
      }, undefined),
    [guard, reload],
  );

  const reset = useCallback(
    () =>
      guard(async () => {
        await api("/api/fs?reset=1", { method: "DELETE" });
        await reload();
      }, undefined),
    [guard, reload],
  );

  const setSetting = useCallback(
    (key: string, value: string) => {
      epoch.current++;
      setSettings((s) => ({ ...s, [key]: value }));
      api("/api/settings", { method: "PUT", body: JSON.stringify({ key, value }) }).catch(() =>
        toast("设置保存失败"),
      );
    },
    [toast],
  );

  const value = useMemo<FsApi>(
    () => ({
      ready,
      nodes,
      settings,
      desktopId,
      trashId,
      documentsId,
      get,
      children: childrenOf,
      pathOf,
      isInTrash,
      resolvePath,
      create,
      rename,
      save,
      move,
      trash,
      restore,
      destroy,
      emptyTrash,
      setSetting,
      reload,
      reset,
    }),
    [
      ready,
      nodes,
      settings,
      desktopId,
      trashId,
      documentsId,
      get,
      childrenOf,
      pathOf,
      isInTrash,
      resolvePath,
      create,
      rename,
      save,
      move,
      trash,
      restore,
      destroy,
      emptyTrash,
      setSetting,
      reload,
      reset,
    ],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
