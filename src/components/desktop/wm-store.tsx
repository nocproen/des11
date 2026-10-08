"use client";

import { useDesktopSync } from "./use-desktop-sync";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";

export type AppId =
  | "lite"
  | "gui"
  | "browser"
  | "sysfiles"
  | "systerm"
  | "monitor"
  | "sysedit"
  | "files"
  | "notepad"
  | "terminal"
  | "settings"
  | "calculator";

export const APPS: Record<
  AppId,
  { name: string; icon: string; gradient: string; w: number; h: number; single?: boolean; hidden?: boolean }
> = {
  gui: { name: "应用", icon: "🚀", gradient: "from-fuchsia-500 to-indigo-600", w: 1000, h: 660, hidden: true },
  browser: { name: "浏览器", icon: "🌐", gradient: "from-sky-400 to-cyan-600", w: 1100, h: 700, single: true },
  lite: { name: "极速浏览器", icon: "⚡", gradient: "from-amber-400 to-orange-500", w: 1040, h: 680 },
  sysfiles: { name: "文件管理器", icon: "📂", gradient: "from-amber-400 to-orange-500", w: 820, h: 520 },
  systerm: { name: "终端", icon: "⌨️", gradient: "from-slate-600 to-slate-900", w: 720, h: 440 },
  monitor: {
    name: "系统监视器",
    icon: "📊",
    gradient: "from-rose-400 to-pink-600",
    w: 780,
    h: 520,
    single: true,
  },
  sysedit: {
    name: "文本编辑器",
    icon: "✏️",
    gradient: "from-sky-400 to-blue-600",
    w: 640,
    h: 460,
    hidden: true,
  },
  files: { name: "云盘", icon: "☁️", gradient: "from-sky-400 to-indigo-500", w: 760, h: 480 },
  notepad: { name: "云盘记事本", icon: "📝", gradient: "from-sky-400 to-blue-600", w: 560, h: 420 },
  terminal: { name: "沙盒终端", icon: "🧪", gradient: "from-violet-500 to-fuchsia-700", w: 660, h: 400 },
  settings: {
    name: "设置",
    icon: "⚙️",
    gradient: "from-slate-400 to-slate-600",
    w: 700,
    h: 480,
    single: true,
  },
  calculator: {
    name: "计算器",
    icon: "🧮",
    gradient: "from-emerald-400 to-teal-600",
    w: 320,
    h: 470,
    single: true,
  },
};

export type Win = {
  id: string;
  app: AppId;
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
  minimized: boolean;
  maximized: boolean;
  folderId?: number | null;
  fileId?: number;
  path?: string;
  title?: string;
  cmd?: string;
  desktopFile?: string;
  iconUrl?: string;
  /** 只属于发起它的那个浏览器，不参与同步 */
  pendingUrl?: string;
};

type State = { wins: Win[]; z: number; seq: number };

type Action =
  | { type: "open"; win: Omit<Win, "id" | "z"> }
  | { type: "focus"; id: string }
  | { type: "close"; id: string }
  | { type: "minimize"; id: string }
  | { type: "toggleMax"; id: string }
  | { type: "patch"; id: string; patch: Partial<Win> }
  | { type: "showDesktop" }
  | { type: "restoreAll" }
  | { type: "closeFile"; fileId: number }
  | { type: "replace"; state: State };

const EMPTY_STATE: State = { wins: [], z: 10, seq: 0 };

// 窗口 id 全局唯一（不同浏览器各自生成也不会重复），它同时也是服务器端应用会话的共享键
const newWinId = () => `w${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

function reducer(s: State, a: Action): State {
  switch (a.type) {
    case "replace":
      return a.state;
    case "open": {
      const seq = s.seq + 1;
      const z = s.z + 1;
      return { wins: [...s.wins, { ...a.win, id: newWinId(), z }], z, seq };
    }
    case "focus": {
      const z = s.z + 1;
      return {
        z,
        seq: s.seq,
        wins: s.wins.map((w) => (w.id === a.id ? { ...w, z, minimized: false } : w)),
      };
    }
    case "close":
      return { ...s, wins: s.wins.filter((w) => w.id !== a.id) };
    case "closeFile":
      return { ...s, wins: s.wins.filter((w) => !(w.app === "notepad" && w.fileId === a.fileId)) };
    case "minimize":
      return { ...s, wins: s.wins.map((w) => (w.id === a.id ? { ...w, minimized: true } : w)) };
    case "toggleMax":
      return {
        ...s,
        wins: s.wins.map((w) => (w.id === a.id ? { ...w, maximized: !w.maximized } : w)),
      };
    case "patch":
      return { ...s, wins: s.wins.map((w) => (w.id === a.id ? { ...w, ...a.patch } : w)) };
    case "showDesktop":
      return { ...s, wins: s.wins.map((w) => ({ ...w, minimized: true })) };
    case "restoreAll":
      return { ...s, wins: s.wins.map((w) => ({ ...w, minimized: false })) };
  }
}

type OpenOpts = {
  folderId?: number | null;
  fileId?: number;
  path?: string;
  cmd?: string;
  desktopFile?: string;
  name?: string;
  iconUrl?: string;
};

type WmApi = {
  wins: Win[];
  focusedId: string | null;
  isMobile: boolean;
  open: (app: AppId, opts?: OpenOpts) => void;
  focus: (id: string) => void;
  close: (id: string) => void;
  minimize: (id: string) => void;
  toggleMax: (id: string) => void;
  patch: (id: string, patch: Partial<Win>) => void;
  showDesktop: () => void;
  closeFile: (fileId: number) => void;
  toggleApp: (app: AppId) => void;
};

const Ctx = createContext<WmApi | null>(null);

export function useWm() {
  const v = useContext(Ctx);
  if (!v) throw new Error("WmProvider missing");
  return v;
}

export function WmProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, EMPTY_STATE);
  const [isMobile, setIsMobile] = useState(false);
  const cid = useState(() => Math.random().toString(36).slice(2) + Date.now().toString(36))[0];

  const stateRef = useRef<State>(state);
  // 最近一次从服务器应用过来的状态对象：与它相同的本地状态不需要再发回服务器
  const appliedRef = useRef<State | null>(null);
  const scheduleRef = useRef<() => void>(() => {});

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  const replaceShared = useCallback((next: State) => dispatch({ type: "replace", state: next }), []);
  useDesktopSync(cid, stateRef, appliedRef, scheduleRef, replaceShared);

  useEffect(() => {
    stateRef.current = state;
    if (state !== appliedRef.current) scheduleRef.current();
  }, [state]);

  const visible = state.wins.filter((w) => !w.minimized);
  const focusedId = visible.length
    ? visible.reduce((a, b) => (b.z > a.z ? b : a)).id
    : null;

  const open = useCallback(
    (app: AppId, opts: OpenOpts = {}) => {
      const existing = state.wins.find((w) => {
        if (w.app !== app) return false;
        if (app === "notepad") return opts.fileId !== undefined && w.fileId === opts.fileId;
        if (app === "sysedit" || app === "sysfiles") return opts.path !== undefined && w.path === opts.path;
        if (app === "gui") {
          const key = opts.desktopFile ?? opts.cmd;
          return key !== undefined && (w.desktopFile ?? w.cmd) === key;
        }
        if (app === "systerm") return false;
        if (app === "files") return opts.folderId !== undefined && w.folderId === opts.folderId;
        return APPS[app].single;
      });
      if (existing) {
        // 浏览器只有一个窗口：新网址交给它在新标签页打开
        if (app === "browser" && opts.path) dispatch({ type: "patch", id: existing.id, patch: { pendingUrl: opts.path } });
        dispatch({ type: "focus", id: existing.id });
        return;
      }
      const def = APPS[app];
      const vw = window.innerWidth;
      const vh = window.innerHeight - 56;
      const w = Math.min(def.w, vw - 20);
      const h = Math.min(def.h, vh - 20);
      const n = state.wins.length % 8;
      const x = Math.max(8, Math.min(80 + n * 32, vw - w - 8));
      const y = Math.max(8, Math.min(40 + n * 32, vh - h - 8));
      dispatch({
        type: "open",
        win: {
          app,
          x,
          y,
          w,
          h,
          minimized: false,
          maximized: false,
          folderId: app === "files" ? (opts.folderId ?? null) : undefined,
          fileId: opts.fileId,
          cmd: opts.cmd,
          desktopFile: opts.desktopFile,
          title: opts.name,
          iconUrl: opts.iconUrl,
          path: app === "sysfiles" ? (opts.path ?? "~") : opts.path,
        },
      });
    },
    [state.wins],
  );

  const toggleApp = useCallback(
    (app: AppId) => {
      const mine = state.wins.filter((w) => w.app === app);
      if (mine.length === 0)
        return open(
          app,
          app === "files" ? { folderId: null } : app === "sysfiles" ? { path: "~" } : {},
        );
      const top = mine.reduce((a, b) => (b.z > a.z ? b : a));
      if (top.id === focusedId) dispatch({ type: "minimize", id: top.id });
      else dispatch({ type: "focus", id: top.id });
    },
    [state.wins, focusedId, open],
  );

  const value = useMemo<WmApi>(
    () => ({
      wins: state.wins,
      focusedId,
      isMobile,
      open,
      toggleApp,
      focus: (id) => dispatch({ type: "focus", id }),
      close: (id) => dispatch({ type: "close", id }),
      minimize: (id) => dispatch({ type: "minimize", id }),
      toggleMax: (id) => dispatch({ type: "toggleMax", id }),
      patch: (id, patch) => dispatch({ type: "patch", id, patch }),
      showDesktop: () =>
        dispatch({
          type: state.wins.some((w) => !w.minimized) ? "showDesktop" : "restoreAll",
        }),
      closeFile: (fileId) => dispatch({ type: "closeFile", fileId }),
    }),
    [state.wins, focusedId, isMobile, open, toggleApp],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
