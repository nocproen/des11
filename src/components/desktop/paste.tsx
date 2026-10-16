"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type CSSProperties,
  type DragEvent,
  type ReactNode,
} from "react";
import { accentColor } from "./defs";
import { useDialogs } from "./dialogs";
import { useFs } from "./fs-store";
import { baseName, sysApi, useSys, useSysOps } from "./sys-store";

// 粘贴 / 拖入 Windows 里的文件和截图，写到服务器上的真实目录。
//
// 浏览器的限制决定了做法：
//  • 内存里的图片（截图、网页上"复制图片"）可以在点击"粘贴"时直接用剪贴板接口读出来；
//  • 在资源管理器里"复制"的文件，网页只能在用户按 Ctrl+V（paste 事件）或拖进来时拿到。
// 所以点"粘贴"时先读图片，读不到就弹出一个小窗口，让用户在里面按一下 Ctrl+V（或把文件拖进来）。
// 另外，在桌面 / 文件管理器里直接按 Ctrl+V、或者把文件从 Windows 拖进来，也会粘贴到对应目录。

type Item = { file: File; rel: string }; // rel：相对目标目录的路径（文件夹里的文件带子目录）
type Picked = { items: Item[]; dirs: string[]; unreadable: string[] };

const CHUNK = 8 * 1024 * 1024;

const pad = (n: number) => String(n).padStart(2, "0");
function stampName(ext: string) {
  const d = new Date();
  return `粘贴的图片 ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.${ext}`;
}
const extOf = (mime: string) => ({ "image/jpeg": "jpg", "image/svg+xml": "svg" })[mime] ?? (mime.split("/")[1] || "png");
// 剪贴板里的位图在浏览器里统一叫 image.png，换成带时间的名字，免得互相覆盖
const fixName = (f: File) => (!f.name || /^image\.(png|jpe?g|gif|bmp|webp)$/i.test(f.name) ? stampName(extOf(f.type)) : f.name);

/* ---------------- 从 paste / drop 事件里取出文件（含文件夹） ---------------- */

type FsEntry = {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file?: (ok: (f: File) => void, err: (e: unknown) => void) => void;
  createReader?: () => { readEntries: (ok: (e: FsEntry[]) => void, err: (e: unknown) => void) => void };
};

async function walk(entry: FsEntry, prefix: string, out: Picked) {
  const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
  if (entry.isFile && entry.file) {
    const f = await new Promise<File>((ok, err) => entry.file!(ok, err)).catch(() => null);
    if (f) out.items.push({ file: f, rel });
    else out.unreadable.push(rel);
  } else if (entry.isDirectory && entry.createReader) {
    const reader = entry.createReader();
    let n = 0;
    for (;;) {
      const batch = await new Promise<FsEntry[]>((ok, err) => reader.readEntries(ok, err)).catch(() => []);
      if (!batch.length) break;
      for (const e of batch) {
        n++;
        await walk(e, rel, out);
      }
    }
    if (!n) out.dirs.push(rel);
  }
}

// 必须在事件处理函数里同步调用（事件结束后 DataTransfer 就读不到了），返回的 Promise 可以之后再等
function pickFrom(dt: DataTransfer | null): Promise<Picked> {
  const out: Picked = { items: [], dirs: [], unreadable: [] };
  if (!dt) return Promise.resolve(out);
  const entries: FsEntry[] = [];
  const files: File[] = [];
  for (const it of Array.from(dt.items ?? [])) {
    if (it.kind !== "file") continue;
    const entry = (it as DataTransferItem & { webkitGetAsEntry?: () => FsEntry | null }).webkitGetAsEntry?.();
    if (entry) entries.push(entry);
    else {
      const f = it.getAsFile();
      if (f) files.push(f);
    }
  }
  if (!entries.length && !files.length) files.push(...Array.from(dt.files ?? []));
  return (async () => {
    for (const e of entries) await walk(e, "", out);
    for (const f of files) {
      // 资源管理器里复制的文件夹，粘贴时浏览器只给一个读不出内容的空壳
      const ok = await f.slice(0, 1).arrayBuffer().then(
        () => true,
        () => false,
      );
      if (ok) out.items.push({ file: f, rel: fixName(f) });
      else out.unreadable.push(f.name || "（未知）");
    }
    return out;
  })();
}

/* ---------------- 上传 ---------------- */

async function post(url: string, body?: Blob) {
  let last: unknown;
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(url, { method: "POST", body, cache: "no-store" });
      const data = (await r.json().catch(() => ({}))) as { error?: string; path?: string };
      if (r.ok) return data;
      last = new Error(data.error ?? `上传失败（${r.status}）`);
      if (r.status < 500 && r.status !== 408 && r.status !== 429) break; // 参数 / 权限问题，重试也没用
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, 800 * (i + 1)));
  }
  throw last instanceof Error ? last : new Error("上传失败");
}

const q = encodeURIComponent;

// 顶层重名的文件夹改名（文件由服务器改名）
async function renameTopFolders(dir: string, picked: Picked) {
  const tops = new Set([
    ...picked.items.filter((i) => i.rel.includes("/")).map((i) => i.rel.split("/")[0]),
    ...picked.dirs.map((d) => d.split("/")[0]),
  ]);
  if (!tops.size) return;
  const taken = new Set((await sysApi.list(dir, true).catch(() => ({ entries: [] }))).entries.map((e) => e.name));
  const map = new Map<string, string>();
  for (const t of tops) {
    let name = t;
    for (let i = 2; taken.has(name); i++) name = `${t} (${i})`;
    taken.add(name);
    map.set(t, name);
  }
  const fix = (r: string) => {
    const [h, ...rest] = r.split("/");
    return [map.get(h) ?? h, ...rest].join("/");
  };
  picked.items.forEach((i) => (i.rel = fix(i.rel)));
  picked.dirs = picked.dirs.map(fix);
}

type Progress = { dir: string; done: number; total: number; bytes: number; totalBytes: number; current: string };

/* ---------------- Context ---------------- */

type PasteApi = {
  /** 右键菜单"粘贴"：粘贴到 dir */
  paste: (dir: string) => void;
  /** 从本地电脑粘贴 / 上传文件到 dir */
  pasteLocal: (dir: string) => void;
  /** 让某个区域接收从 Windows 拖进来的文件 */
  fileDrop: (dir: string | null) => { onDragOver: (e: DragEvent) => void; onDrop: (e: DragEvent) => void };
};

const Ctx = createContext<PasteApi | null>(null);

export function usePaste() {
  const v = useContext(Ctx);
  if (!v) throw new Error("PasteProvider missing");
  return v;
}

const hasFiles = (e: DragEvent) => e.dataTransfer.types.includes("Files");

export function PasteProvider({ children }: { children: ReactNode }) {
  const dlg = useDialogs();
  const fs = useFs();
  const { bump, clip } = useSys();
  const ops = useSysOps();
  const [progress, setProgress] = useState<Progress | null>(null);
  const [askDir, setAskDir] = useState<string | null>(null);
  const busy = useRef(false);
  const queue = useRef<{ dir: string; picked: Promise<Picked> }[]>([]);

  const run = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      for (let job = queue.current.shift(); job; job = queue.current.shift()) {
        const { dir } = job;
        const picked = await job.picked;
        for (const u of picked.unreadable) dlg.toast(`「${u}」读不出来（复制的文件夹请直接拖进来）`);
        if (!picked.items.length && !picked.dirs.length) {
          if (!picked.unreadable.length) dlg.toast("剪贴板里没有文件或图片");
          continue;
        }
        await renameTopFolders(dir, picked);
        const totalBytes = picked.items.reduce((s, i) => s + i.file.size, 0);
        let bytes = 0;
        let ok = 0;
        const total = picked.items.length;
        setProgress({ dir, done: 0, total, bytes: 0, totalBytes, current: "" });
        for (const d of picked.dirs) {
          await post(`/api/sys/upload?mkdir=1&dir=${q(dir)}&name=${q(d)}`).catch(() => {});
        }
        for (const [n, { file, rel }] of picked.items.entries()) {
          const id = (Date.now().toString(36) + Math.random().toString(36).slice(2, 12)).toLowerCase();
          const base = `/api/sys/upload?dir=${q(dir)}&name=${q(rel)}&id=${id}`;
          try {
            let off = 0;
            do {
              const end = Math.min(off + CHUNK, file.size);
              await post(`${base}&offset=${off}${end >= file.size ? "&done=1" : ""}`, file.slice(off, end));
              bytes += end - off;
              off = end;
              setProgress({ dir, done: n, total, bytes, totalBytes, current: rel });
            } while (off < file.size);
            ok++;
          } catch (e) {
            void fetch(base, { method: "DELETE" }).catch(() => {});
            dlg.toast(`「${rel}」粘贴失败：${e instanceof Error ? e.message : "未知错误"}`);
          }
          setProgress({ dir, done: n + 1, total, bytes, totalBytes, current: rel });
        }
        bump();
        const where = baseName(dir);
        if (ok) dlg.toast(total === 1 && !picked.dirs.length ? `已粘贴「${baseName(picked.items[0].rel)}」到 ${where}` : `已粘贴 ${ok} 个文件到 ${where}`);
        else if (picked.dirs.length) dlg.toast(`已粘贴到 ${where}`);
      }
    } finally {
      busy.current = false;
      setProgress(null);
    }
  }, [dlg, bump]);

  const enqueue = useCallback(
    (dir: string, picked: Promise<Picked>) => {
      queue.current.push({ dir, picked });
      void run();
    },
    [run],
  );

  const pasteLocal = useCallback(
    (dir: string) => {
      void (async () => {
        try {
          const items = await navigator.clipboard.read();
          const imgs: Item[] = [];
          for (const it of items) {
            const type = it.types.find((t) => t.startsWith("image/"));
            if (!type) continue;
            const blob = await it.getType(type);
            const name = stampName(extOf(type));
            imgs.push({ file: new File([blob], name, { type }), rel: name });
          }
          if (imgs.length) return enqueue(dir, Promise.resolve({ items: imgs, dirs: [], unreadable: [] }));
        } catch {
          /* 没权限 / 剪贴板里不是图片：走下面的 Ctrl+V 窗口 */
        }
        setAskDir(dir);
      })();
    },
    [enqueue],
  );

  const paste = useCallback(
    (dir: string) => {
      void (async () => {
        // 1) 如果在模拟桌面 / 文件管理器里已经复制或剪切了文件/图片，直接粘贴到该目录
        if (clip && clip.paths.length > 0) {
          const ok = await ops.pasteFiles(dir, false);
          if (ok) return;
        }
        // 2) 检查 VNC 会话内部是否刚复制了文件或图片
        try {
          const r = await fetch("/api/gui/clipboard?probe=1", { cache: "no-store" });
          if (r.ok) {
            const d = (await r.json()) as { clip?: { paths?: string[] } | null };
            if (d.clip?.paths?.length) {
              const ok = await ops.pasteFiles(dir, true);
              if (ok) return;
            }
          }
        } catch {
          /* ignore */
        }
        // 3) 本地电脑剪贴板里的图片或文件
        pasteLocal(dir);
      })();
    },
    [clip, ops, pasteLocal],
  );

  const fileDrop = useCallback(
    (dir: string | null) => ({
      onDragOver: (e: DragEvent) => {
        if (!dir || !hasFiles(e)) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "copy";
      },
      onDrop: (e: DragEvent) => {
        if (!dir || !hasFiles(e)) return;
        e.preventDefault();
        e.stopPropagation();
        enqueue(dir, pickFrom(e.dataTransfer));
      },
    }),
    [enqueue],
  );

  // 在桌面 / 文件管理器里直接按 Ctrl+V：粘贴到焦点所在区域的 data-paste-dir 目录
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (askDir !== null) return; // 弹窗自己处理
      const t = e.target as HTMLElement | null;
      if (!t || t.closest("input, textarea, [contenteditable=''], [contenteditable='true']")) return;
      const dir = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>("[data-paste-dir]")?.dataset.pasteDir;
      if (!dir) return;
      const dt = e.clipboardData;
      if (dt && Array.from(dt.types).includes("Files")) {
        e.preventDefault();
        enqueue(dir, pickFrom(dt));
        return;
      }
      if (clip && clip.paths.length > 0) {
        e.preventDefault();
        void ops.pasteFiles(dir, false);
      }
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [askDir, clip, enqueue, ops]);

  const api = useMemo(() => ({ paste, pasteLocal, fileDrop }), [paste, pasteLocal, fileDrop]);

  return (
    <Ctx.Provider value={api}>
      {children}
      <div style={{ "--accent": accentColor(fs.settings) } as CSSProperties}>
      {askDir !== null && (
        <PasteBox
          dir={askDir}
          onClose={() => setAskDir(null)}
          onPicked={(p) => {
            enqueue(askDir, p);
            setAskDir(null);
          }}
        />
      )}
      {progress && <ProgressCard p={progress} />}
      </div>
    </Ctx.Provider>
  );
}

/* ---------------- 界面 ---------------- */

function PasteBox({ dir, onClose, onPicked }: { dir: string; onClose: () => void; onPicked: (p: Promise<Picked>) => void }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [hint, setHint] = useState("");

  useEffect(() => {
    boxRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const onPaste = (e: ReactClipboardEvent) => {
    e.preventDefault();
    const dt = e.clipboardData;
    if (!Array.from(dt.types).includes("Files")) {
      setHint("剪贴板里没有文件或图片。请先在 Windows 里选中文件按 Ctrl+C，再回到这里按 Ctrl+V。");
      return;
    }
    onPicked(pickFrom(dt));
  };

  return (
    <div
      className="fixed inset-0 z-[9999] grid place-items-center bg-black/40 p-4 backdrop-blur-[2px]"
      onPointerDown={(e) => {
        e.stopPropagation();
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-md animate-[pop_0.15s_ease-out] rounded-2xl border border-white/10 bg-slate-800/95 p-5 text-slate-100 shadow-2xl">
        <h3 className="text-base font-semibold">粘贴到「{baseName(dir)}」</h3>
        <div
          ref={boxRef}
          tabIndex={0}
          onPaste={onPaste}
          onDragOver={(e) => {
            if (!hasFiles(e)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            if (!hasFiles(e)) return;
            e.preventDefault();
            onPicked(pickFrom(e.dataTransfer));
          }}
          className={`mt-4 grid min-h-36 cursor-text place-items-center rounded-xl border-2 border-dashed px-4 py-6 text-center outline-none transition-colors ${
            over ? "border-[var(--accent)] bg-[var(--accent)]/10" : "border-white/20 focus:border-[var(--accent)]"
          }`}
        >
          <div>
            <div className="text-3xl">📋</div>
            <div className="mt-2 text-sm">
              现在按 <kbd className="rounded border border-white/20 bg-white/10 px-1.5 py-0.5 text-xs">Ctrl</kbd> +{" "}
              <kbd className="rounded border border-white/20 bg-white/10 px-1.5 py-0.5 text-xs">V</kbd>
            </div>
            <div className="mt-1 text-xs text-slate-400">或者把文件 / 文件夹从 Windows 拖到这里</div>
          </div>
        </div>
        <p className="mt-3 text-xs leading-relaxed text-slate-400">
          {hint ||
            "浏览器不允许网页在点击时直接读取 Windows 里复制的文件，需要你在这里按一下 Ctrl+V。以后也可以在桌面或文件夹里直接按 Ctrl+V。"}
        </p>
        <div className="mt-4 flex justify-between gap-2">
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="rounded-lg px-3 py-1.5 text-sm text-slate-300 hover:bg-white/10"
          >
            选择文件…
          </button>
          <button type="button" onClick={onClose} className="rounded-lg px-4 py-1.5 text-sm text-slate-300 hover:bg-white/10">
            取消
          </button>
        </div>
        <input
          ref={fileRef}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            if (files.length) onPicked(Promise.resolve({ items: files.map((f) => ({ file: f, rel: f.name })), dirs: [], unreadable: [] }));
          }}
        />
      </div>
    </div>
  );
}

const mb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(n / 1024)} KB`);

function ProgressCard({ p }: { p: Progress }) {
  const pct = p.totalBytes ? Math.floor((p.bytes / p.totalBytes) * 100) : 100;
  return (
    <div className="fixed bottom-16 right-4 z-[9500] w-72 rounded-xl border border-white/10 bg-slate-800/95 p-3 text-sm text-slate-100 shadow-2xl backdrop-blur">
      <div className="flex justify-between">
        <span>正在粘贴到「{baseName(p.dir)}」</span>
        <span className="text-slate-400">
          {Math.min(p.done + 1, p.total)}/{p.total}
        </span>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/10">
        <div className="h-full bg-[var(--accent)] transition-[width]" style={{ width: `${pct}%` }} />
      </div>
      <div className="mt-1.5 flex justify-between gap-2 text-xs text-slate-400">
        <span className="truncate">{p.current || "准备中…"}</span>
        <span className="shrink-0">
          {mb(p.bytes)} / {mb(p.totalBytes)}
        </span>
      </div>
    </div>
  );
}
