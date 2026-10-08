"use client";

import { useEffect, useRef, useState } from "react";
import { useDialogs } from "../dialogs";
import { useFs } from "../fs-store";
import type { Win } from "../wm-store";
import { useWm } from "../wm-store";

export function NotepadApp({ win }: { win: Win }) {
  const fs = useFs();
  const wm = useWm();
  const dlg = useDialogs();
  const file = fs.get(win.fileId);
  const [text, setText] = useState(file?.content ?? "");
  const [savedText, setSavedText] = useState(file?.content ?? "");
  const [saving, setSaving] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => ref.current?.focus(), []);

  const dirty = text !== savedText;
  const externalChange = !!file && file.content !== savedText && dirty;
  useEffect(() => {
    if (file && !dirty && !saving && file.content !== savedText) {
      setText(file.content);
      setSavedText(file.content);
    }
  }, [file, dirty, saving, savedText]);

  const save = async () => {
    if (saving) return;
    setSaving(true);
    try {
      if (file) {
        const n = await fs.save(file.id, text, savedText);
        if (n) setSavedText(text);
      } else {
        const name = await dlg.prompt({
          title: "保存文件",
          label: "将保存到 Documents 文件夹",
          value: "未命名.txt",
          confirmText: "保存",
        });
        if (!name) return;
        const n = await fs.create(fs.documentsId, name, "file", text);
        if (n) {
          setSavedText(text);
          wm.patch(win.id, { fileId: n.id });
          dlg.toast(`已保存为 ${n.name}`);
        }
      }
    } finally {
      setSaving(false);
    }
  };

  if (win.fileId !== undefined && !file) {
    return (
      <div className="grid h-full place-items-center text-sm text-slate-400">文件已被删除</div>
    );
  }

  const words = text.length;
  const lines = text.split("\n").length;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-white/10 bg-white/[0.03] px-2 py-1.5 text-xs">
        <button
          onClick={() => void save()}
          disabled={!dirty && !!file}
          className="rounded-md bg-[var(--accent)] px-3 py-1 font-medium text-white disabled:opacity-40"
        >
          {saving ? "保存中…" : "保存"}
        </button>
        <span className="text-slate-400">
          {file ? fs.pathOf(file.id) : "未命名"}
        </span>
        <span className={`ml-auto ${dirty ? "text-amber-300" : "text-emerald-300"}`}>
          {dirty ? "● 未保存" : "已保存"}
        </span>
      </div>
      {externalChange && <div role="status" className="flex items-center justify-between gap-2 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
        <span>文件已在其他界面修改。你的未保存内容已保留。</span>
        <button className="shrink-0 underline" onClick={async () => {
          if (file && await dlg.confirm({ title: "重新加载", message: "放弃本地未保存内容，加载服务器上的最新版本？" })) {
            setText(file.content); setSavedText(file.content);
          }
        }}>重新加载</button>
      </div>}
      <textarea
        ref={ref}
        value={text}
        spellCheck={false}
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
            const next = text.slice(0, s) + "  " + text.slice(en);
            setText(next);
            requestAnimationFrame(() => el.setSelectionRange(s + 2, s + 2));
          }
        }}
        className="min-h-0 flex-1 resize-none bg-slate-950/40 p-3 font-mono text-sm leading-relaxed text-slate-100 outline-none"
        placeholder="在这里输入内容…（Ctrl+S 保存）"
      />
      <div className="flex justify-between border-t border-white/10 px-3 py-1 text-xs text-slate-400">
        <span>{lines} 行</span>
        <span>{words} 字符</span>
      </div>
    </div>
  );
}
