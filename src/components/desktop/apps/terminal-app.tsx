"use client";

import { useEffect, useRef, useState } from "react";
import { useFs, type FsNode } from "../fs-store";
import { APPS, useWm, type AppId, type Win } from "../wm-store";

type Line = { kind: "in" | "out" | "err"; text: string };

const COMMANDS = [
  "help", "ls", "cd", "pwd", "cat", "mkdir", "touch", "rm", "mv", "cp", "echo", "clear",
  "date", "whoami", "uname", "hostname", "tree", "open", "edit", "neofetch", "history",
  "exit", "uptime",
];

const HELP = `可用命令:
  ls [-l] [路径]     列出目录内容
  cd [路径]          切换目录 (支持 .. / ~ 绝对路径)
  pwd                显示当前路径
  cat <文件>         查看文件内容
  mkdir <名称>       新建文件夹
  touch <名称>       新建空文件
  echo 文本 > 文件   写入文件 (>> 为追加)
  cp <源> <目标>     复制文件
  mv <源> <目标>     移动 / 重命名
  rm [-f] <路径>     删除 (默认进回收站, -f 永久删除)
  tree [路径]        树状显示目录
  open <路径|应用>   用图形界面打开 (files/notepad/settings/calculator)
  edit <文件>        用记事本编辑 (不存在则创建)
  neofetch / uname / whoami / date / uptime / history / clear / exit`;

function tokenize(input: string) {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(>>|>|[^\s>]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

export function TerminalApp({ win }: { win: Win }) {
  const fs = useFs();
  const wm = useWm();
  const [lines, setLines] = useState<Line[]>([
    { kind: "out", text: "WebDesktop Terminal 1.0 — 输入 help 查看命令" },
  ]);
  const [input, setInput] = useState("");
  const [cwd, setCwd] = useState<number | null>(fs.desktopId);
  const cwdRef = useRef<number | null>(fs.desktopId);
  const [busy, setBusy] = useState(false);
  const hist = useRef<string[]>([]);
  const histIdx = useRef(-1);
  const bodyRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const startedAt = useRef(Date.now());

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight });
  }, [lines]);
  useEffect(() => inputRef.current?.focus(), []);

  const promptStr = () => `guest@webdesktop:${fs.pathOf(cwd)}$`;
  const setDir = (id: number | null) => {
    cwdRef.current = id;
    setCwd(id);
  };

  const split = (path: string) => {
    const i = path.lastIndexOf("/");
    const dir = i >= 0 ? path.slice(0, i) || "/" : ".";
    return { dir, base: i >= 0 ? path.slice(i + 1) : path };
  };

  async function exec(raw: string): Promise<Line[]> {
    const out: Line[] = [];
    const o = (text: string) => out.push({ kind: "out", text });
    const e = (text: string) => out.push({ kind: "err", text });
    let args = tokenize(raw);
    if (!args.length) return out;

    // 重定向
    let redirect: { file: string; append: boolean } | null = null;
    const ri = args.findIndex((a) => a === ">" || a === ">>");
    if (ri >= 0) {
      if (!args[ri + 1]) {
        e("语法错误: 缺少重定向目标");
        return out;
      }
      redirect = { file: args[ri + 1], append: args[ri] === ">>" };
      args = args.slice(0, ri);
    }
    const [cmd, ...rest] = args;
    const flags = rest.filter((a) => a.startsWith("-") && a.length > 1);
    const params = rest.filter((a) => !(a.startsWith("-") && a.length > 1));
    const cur = cwdRef.current;
    const res = (p: string) => fs.resolvePath(p, cur);

    const nodeLine = (n: FsNode, long: boolean) =>
      long
        ? `${n.kind === "folder" ? "d" : "-"}rw-r--r--  ${String(n.content.length).padStart(6)}  ${new Date(
            n.updatedAt,
          ).toLocaleDateString("zh-CN")}  ${n.name}${n.kind === "folder" ? "/" : ""}`
        : n.name + (n.kind === "folder" ? "/" : "");

    const tree = (id: number | null, prefix: string) => {
      const kids = fs.children(id);
      kids.forEach((k, i) => {
        const last = i === kids.length - 1;
        o(`${prefix}${last ? "└── " : "├── "}${k.name}${k.kind === "folder" ? "/" : ""}`);
        if (k.kind === "folder") tree(k.id, prefix + (last ? "    " : "│   "));
      });
    };

    const writeTo = async (text: string) => {
      const { dir, base } = split(redirect!.file);
      const d = res(dir);
      if (!d || (d.node && d.node.kind !== "folder")) return e(`${redirect!.file}: 目录不存在`);
      if (!d.node) return e("不能在根目录创建文件");
      const existing = fs.children(d.node.id).find((c) => c.name === base);
      if (existing) {
        if (existing.kind === "folder") return e(`${base}: 是一个目录`);
        await fs.save(existing.id, redirect!.append ? existing.content + text : text);
      } else {
        await fs.create(d.node.id, base, "file", text);
      }
    };

    switch (cmd) {
      case "help":
        o(HELP);
        break;
      case "clear":
        return [{ kind: "out", text: "\u0000clear" }];
      case "pwd":
        o(fs.pathOf(cur));
        break;
      case "whoami":
        o("guest");
        break;
      case "hostname":
        o("webdesktop");
        break;
      case "date":
        o(new Date().toLocaleString("zh-CN", { hour12: false }));
        break;
      case "uname":
        o(flags.length ? "WebDesktop 1.0 browser x86_64 Next.js/PostgreSQL" : "WebDesktop");
        break;
      case "uptime": {
        const s = Math.floor((Date.now() - startedAt.current) / 1000);
        o(`运行 ${Math.floor(s / 60)} 分 ${s % 60} 秒`);
        break;
      }
      case "history":
        hist.current.slice().reverse().forEach((h, i) => o(`${String(i + 1).padStart(4)}  ${h}`));
        break;
      case "neofetch": {
        const files = fs.nodes.filter((n) => n.kind === "file").length;
        const dirs = fs.nodes.filter((n) => n.kind === "folder").length;
        o(
          [
            "   ┌───────────┐   guest@webdesktop",
            "   │  ◉     ◉  │   ------------------",
            "   │    ───    │   OS:       WebDesktop 1.0",
            "   └─┬───────┬─┘   Shell:    websh",
            "     │       │     Windows:  " + wm.wins.length,
            `   ──┴───────┴──   Files:    ${files} 文件 / ${dirs} 文件夹`,
            "                   Storage:  PostgreSQL",
          ].join("\n"),
        );
        break;
      }
      case "exit":
        wm.close(win.id);
        break;
      case "ls": {
        const target = params[0] ? res(params[0]) : { node: cur === null ? null : (fs.get(cur) ?? null) };
        if (!target) return e(`ls: 无法访问 '${params[0]}': 没有那个文件或目录`), out;
        if (target.node && target.node.kind === "file") {
          o(nodeLine(target.node, flags.includes("-l")));
          break;
        }
        const kids = fs.children(target.node?.id ?? null);
        if (!kids.length) break;
        o(flags.includes("-l") ? kids.map((k) => nodeLine(k, true)).join("\n") : kids.map((k) => nodeLine(k, false)).join("   "));
        break;
      }
      case "cd": {
        if (!params[0]) {
          setDir(fs.desktopId);
          break;
        }
        const t = res(params[0]);
        if (!t) e(`cd: ${params[0]}: 没有那个文件或目录`);
        else if (t.node && t.node.kind !== "folder") e(`cd: ${params[0]}: 不是目录`);
        else setDir(t.node?.id ?? null);
        break;
      }
      case "cat": {
        if (!params.length) return e("cat: 缺少文件名"), out;
        for (const p of params) {
          const t = res(p);
          if (!t || !t.node) e(`cat: ${p}: 没有那个文件或目录`);
          else if (t.node.kind === "folder") e(`cat: ${p}: 是一个目录`);
          else o(t.node.content.replace(/\n$/, ""));
        }
        break;
      }
      case "echo": {
        const text = params.join(" ");
        if (redirect) await writeTo(text + "\n");
        else o(text);
        break;
      }
      case "mkdir":
      case "touch": {
        if (!params.length) return e(`${cmd}: 缺少操作数`), out;
        for (const p of params) {
          const { dir, base } = split(p);
          const d = res(dir);
          if (!d || (d.node && d.node.kind !== "folder")) {
            e(`${cmd}: 无法创建 '${p}': 目录不存在`);
            continue;
          }
          if (!d.node) {
            e(`${cmd}: 不能在根目录创建`);
            continue;
          }
          const exists = fs.children(d.node.id).find((c) => c.name === base);
          if (exists) {
            if (cmd === "mkdir") e(`mkdir: 无法创建 '${p}': 已存在`);
            continue;
          }
          await fs.create(d.node.id, base, cmd === "mkdir" ? "folder" : "file");
        }
        break;
      }
      case "rm": {
        if (!params.length) return e("rm: 缺少操作数"), out;
        for (const p of params) {
          const t = res(p);
          if (!t || !t.node) e(`rm: 无法删除 '${p}': 没有那个文件或目录`);
          else if (t.node.parentId === null) e(`rm: 无法删除系统目录 '${p}'`);
          else if (t.node.kind === "folder" && !flags.some((f) => f.includes("r") || f.includes("f")))
            e(`rm: 无法删除 '${p}': 是一个目录 (使用 -r)`);
          else {
            const permanent = flags.some((f) => f.includes("f"));
            const id = t.node.id;
            const ok = permanent || fs.isInTrash(id) ? await fs.destroy(id) : await fs.trash(id);
            if (ok) wm.closeFile(id);
            if (cur !== null && !fs.get(cur)) setDir(fs.desktopId);
          }
        }
        break;
      }
      case "cp": {
        if (params.length < 2) return e("cp: 用法: cp <源> <目标>"), out;
        const s = res(params[0]);
        if (!s || !s.node) return e(`cp: ${params[0]}: 没有那个文件或目录`), out;
        if (s.node.kind === "folder") return e("cp: 暂不支持复制目录"), out;
        const t = res(params[1]);
        if (t?.node && t.node.kind === "folder") await fs.create(t.node.id, s.node.name, "file", s.node.content);
        else {
          const { dir, base } = split(params[1]);
          const d = res(dir);
          if (!d || !d.node || d.node.kind !== "folder") return e("cp: 目标目录不存在"), out;
          await fs.create(d.node.id, base, "file", s.node.content);
        }
        break;
      }
      case "mv": {
        if (params.length < 2) return e("mv: 用法: mv <源> <目标>"), out;
        const s = res(params[0]);
        if (!s || !s.node) return e(`mv: ${params[0]}: 没有那个文件或目录`), out;
        if (s.node.parentId === null) return e("mv: 不能移动系统目录"), out;
        const t = res(params[1]);
        if (t?.node && t.node.kind === "folder") {
          await fs.move(s.node.id, t.node.id);
        } else if (!t) {
          const { dir, base } = split(params[1]);
          const d = res(dir);
          if (!d || !d.node || d.node.kind !== "folder") return e("mv: 目标目录不存在"), out;
          if (d.node.id !== s.node.parentId) await fs.move(s.node.id, d.node.id);
          await fs.rename(s.node.id, base);
        } else e("mv: 目标已存在");
        break;
      }
      case "tree": {
        const t = params[0] ? res(params[0]) : { node: cur === null ? null : (fs.get(cur) ?? null) };
        if (!t) return e(`tree: ${params[0]}: 没有那个文件或目录`), out;
        o(t.node ? t.node.name : "/");
        tree(t.node?.id ?? null, "");
        break;
      }
      case "open":
      case "start": {
        const p = params[0];
        if (!p) return e("open: 缺少参数"), out;
        if (p in APPS) {
          wm.open(p as AppId, p === "files" ? { folderId: cur } : {});
          break;
        }
        const t = res(p);
        if (!t) return e(`open: ${p}: 没有那个文件或目录`), out;
        if (!t.node) wm.open("files", { folderId: null });
        else if (t.node.kind === "folder") wm.open("files", { folderId: t.node.id });
        else wm.open("notepad", { fileId: t.node.id });
        break;
      }
      case "edit":
      case "nano":
      case "vim": {
        if (!params[0]) {
          wm.open("notepad");
          break;
        }
        let t = res(params[0]);
        if (!t) {
          const { dir, base } = split(params[0]);
          const d = res(dir);
          if (!d || !d.node || d.node.kind !== "folder") return e("edit: 目录不存在"), out;
          const created = await fs.create(d.node.id, base, "file");
          if (created) wm.open("notepad", { fileId: created.id });
          break;
        }
        if (!t.node || t.node.kind !== "file") return e("edit: 不是文件"), out;
        wm.open("notepad", { fileId: t.node.id });
        t = undefined;
        break;
      }
      default:
        e(`${cmd}: 未找到命令 (输入 help 查看帮助)`);
    }
    return out;
  }

  const run = async () => {
    const raw = input;
    const echoLine: Line = { kind: "in", text: `${promptStr()} ${raw}` };
    setInput("");
    if (raw.trim()) {
      hist.current.unshift(raw);
      histIdx.current = -1;
    }
    setBusy(true);
    try {
      const out = await exec(raw);
      if (out[0]?.text === "\u0000clear") setLines([]);
      else setLines((l) => [...l, echoLine, ...out].slice(-500));
    } catch {
      setLines((l) => [...l, echoLine, { kind: "err", text: "命令执行出错" }]);
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  };

  const complete = () => {
    const m = /(\S*)$/.exec(input);
    const word = m ? m[1] : "";
    const before = input.slice(0, input.length - word.length);
    let candidates: string[];
    if (!before.trim()) {
      candidates = COMMANDS.filter((c) => c.startsWith(word));
    } else {
      const i = word.lastIndexOf("/");
      const dirPart = i >= 0 ? word.slice(0, i + 1) : "";
      const prefix = i >= 0 ? word.slice(i + 1) : word;
      const d = fs.resolvePath(dirPart || ".", cwdRef.current);
      if (!d) return;
      candidates = fs
        .children(d.node?.id ?? null)
        .filter((c) => c.name.startsWith(prefix))
        .map((c) => dirPart + c.name + (c.kind === "folder" ? "/" : ""));
    }
    if (!candidates.length) return;
    let common = candidates[0];
    for (const c of candidates) while (!c.startsWith(common)) common = common.slice(0, -1);
    if (candidates.length === 1 && !common.endsWith("/")) common += " ";
    setInput(before + common);
  };

  return (
    <div
      ref={bodyRef}
      className="h-full overflow-y-auto bg-black/80 p-3 font-mono text-[13px] leading-relaxed text-slate-200"
      onClick={() => {
        if (!window.getSelection()?.toString()) inputRef.current?.focus();
      }}
    >
      {lines.map((l, i) => (
        <div
          key={i}
          className={`whitespace-pre-wrap break-all ${
            l.kind === "err" ? "text-red-400" : l.kind === "in" ? "text-slate-100" : "text-slate-300"
          }`}
        >
          {l.text}
        </div>
      ))}
      <div className="flex items-center gap-2">
        <span className="shrink-0 text-emerald-400">{promptStr()}</span>
        <input
          ref={inputRef}
          value={input}
          disabled={busy}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void run();
            else if (e.key === "Tab") {
              e.preventDefault();
              complete();
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              if (histIdx.current < hist.current.length - 1) {
                histIdx.current++;
                setInput(hist.current[histIdx.current]);
              }
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              if (histIdx.current > 0) {
                histIdx.current--;
                setInput(hist.current[histIdx.current]);
              } else {
                histIdx.current = -1;
                setInput("");
              }
            } else if (e.ctrlKey && e.key.toLowerCase() === "l") {
              e.preventDefault();
              setLines([]);
            }
          }}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          className="min-w-0 flex-1 bg-transparent text-slate-100 caret-emerald-400 outline-none"
        />
      </div>
    </div>
  );
}
