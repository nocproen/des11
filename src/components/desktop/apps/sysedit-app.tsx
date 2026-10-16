"use client";

import { useEffect, useRef, useState } from "react";
import { useDialogs } from "../dialogs";
import { baseName, rawUrl, sysApi, useSysOps, type SysFile } from "../sys-store";
import type { Win } from "../wm-store";
import { fmtSize } from "./sysfiles-app";

const IMG = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "svg"];
const AUDIO = ["mp3", "wav", "ogg"];
const VIDEO = ["mp4", "webm"];

export function SysEditApp({ win }: { win: Win }) {
  const path = win.path ?? "";
  const ops = useSysOps();
  const dlg = useDialogs();
  const [file, setFile] = useState<SysFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [saved, setSaved] = useState("");
  const [saving, setSaving] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  const ext = baseName(path).split(".").pop()?.toLowerCase() ?? "";
  const previewKind = IMG.includes(ext)
    ? "img"
    : AUDIO.includes(ext)
      ? "audio"
      : VIDEO.includes(ext)
        ? "video"
        : ext === "pdf"
          ? "pdf"
          : null;

  useEffect(() => {
    if (previewKind) return;
    let alive = true;
    sysApi
      .read(path)
      .then((f) => {
        if (!alive) return;
        setFile(f);
        setText(f.content);
        setSaved(f.content);
      })
      .catch((e) => alive && setError(e instanceof Error ? e.message : "无法读取文件"));
    return () => {
      alive = false;
    };
  }, [path, previewKind]);

  const dirty = text !== saved;
  const save = async () => {
    if (saving || !dirty) return;
    setSaving(true);
    const r = await ops.save(path, text);
    setSaving(false);
    if (r) {
      setSaved(text);
      dlg.toast("已保存到服务器");
    }
  };

  const header = (
    <div className="flex items-center gap-2 border-b border-white/10 bg-white/[0.03] px-2 py-1.5 text-xs">
      {!previewKind && file && !file.binary && !file.tooLarge && (
        <button
          onClick={() => void save()}
          disabled={!dirty || saving}
          className="rounded-md bg-[var(--accent)] px-3 py-1 font-medium text-white disabled:opacity-40"
        >
          {saving ? "保存中…" : "保存"}
        </button>
      )}
      <span className="min-w-0 flex-1 truncate text-slate-400">{path}</span>
      <button
        type="button"
        onClick={() => void ops.copy(path, false)}
        className="rounded-md px-2 py-1 text-slate-300 hover:bg-white/10"
        title="复制此文件/图片（可直接粘贴到 VNC 应用或文件夹）"
      >
        📋 复制文件{previewKind === "img" ? "/图片" : ""}
      </button>
      <a
        href={rawUrl(path, true)}
        className="rounded-md px-2 py-1 text-slate-300 hover:bg-white/10"
        title="下载"
      >
        ⬇️ 下载
      </a>
      {!previewKind && file && !file.binary && !file.tooLarge && (
        <span className={dirty ? "text-amber-300" : "text-emerald-300"}>
          {dirty ? "● 未保存" : "已保存"}
        </span>
      )}
    </div>
  );

  let body;
  if (previewKind === "img") {
    body = (
      <div className="grid min-h-0 flex-1 place-items-center overflow-auto bg-black/30 p-3">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={rawUrl(path)} alt={baseName(path)} className="max-h-full max-w-full object-contain" />
      </div>
    );
  } else if (previewKind === "audio") {
    body = (
      <div className="grid flex-1 place-items-center p-6">
        <audio controls src={rawUrl(path)} className="w-full max-w-md" />
      </div>
    );
  } else if (previewKind === "video") {
    body = (
      <div className="grid min-h-0 flex-1 place-items-center bg-black p-2">
        <video controls src={rawUrl(path)} className="max-h-full max-w-full" />
      </div>
    );
  } else if (previewKind === "pdf") {
    body = <iframe src={rawUrl(path)} className="min-h-0 flex-1 bg-white" title="pdf" />;
  } else if (error) {
    body = <div className="grid flex-1 place-items-center px-4 text-center text-sm text-red-300">{error}</div>;
  } else if (!file) {
    body = <div className="grid flex-1 place-items-center text-sm text-slate-500">加载中…</div>;
  } else if (file.tooLarge || file.binary) {
    body = (
      <div className="grid flex-1 place-items-center px-4 text-center text-sm text-slate-400">
        <div>
          <div className="mb-2 text-4xl">{file.binary ? "📦" : "🐘"}</div>
          {file.binary ? "这是二进制文件，无法作为文本编辑" : "文件过大（超过 2 MB），无法在线编辑"}
          <div className="mt-1 text-xs text-slate-500">大小 {fmtSize(file.size)}，可点击右上角下载</div>
        </div>
      </div>
    );
  } else {
    body = (
      <textarea
        ref={ref}
        value={text}
        spellCheck={false}
        autoFocus
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
            e.preventDefault();
            void save();
          }
          if (e.key === "Tab") {
            e.preventDefault();
            const el = e.currentTarget;
            const { selectionStart: s, selectionEnd: en } = el;
            setText(text.slice(0, s) + "  " + text.slice(en));
            requestAnimationFrame(() => el.setSelectionRange(s + 2, s + 2));
          }
        }}
        className="min-h-0 flex-1 resize-none bg-slate-950/40 p-3 font-mono text-sm leading-relaxed text-slate-100 outline-none"
      />
    );
  }

  return (
    <div className="flex h-full flex-col">
      {header}
      {body}
      {file && !file.binary && !file.tooLarge && !previewKind && (
        <div className="flex justify-between border-t border-white/10 px-3 py-1 text-xs text-slate-400">
          <span>{text.split("\n").length} 行</span>
          <span>{fmtSize(file.size)}</span>
        </div>
      )}
    </div>
  );
}
