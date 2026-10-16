import fsp from "fs/promises";
import path from "path";
import { HOME } from "@/lib/sys";

// 终端与图形应用共用：子进程环境变量，以及 ~/.webdesktop/bin 下的辅助命令（open / gui / wd-clip.py）。

// open：在终端里用桌面的应用打开文件 / 目录 / 网址（通过 OSC 777 转义序列通知网页）
const OPEN_SCRIPT = `#!/bin/bash
# 用法: open <文件|目录|网址> ...   用桌面里的应用打开
if [ $# -eq 0 ]; then set -- .; fi
for a in "$@"; do
  case "$a" in
    http://*|https://*) printf '\\033]777;open;url;%s\\007' "$a"; continue;;
  esac
  p=$(realpath -m -- "$a" 2>/dev/null || echo "$a")
  if [ -d "$p" ]; then k=dir; elif [ -e "$p" ]; then k=file; else echo "open: $a: 没有那个文件或目录" >&2; continue; fi
  printf '\\033]777;open;%s;%s\\007' "$k" "$p"
done
`;

// gui：把一个图形程序放进桌面窗口里运行（服务器上的虚拟显示器 + 画面转发）
const GUI_SCRIPT = `#!/bin/bash
# 用法: gui <命令> [参数...]   在桌面窗口里运行图形程序，例如: gui xterm   gui /opt/app/app --flag
if [ $# -eq 0 ]; then echo "用法: gui <命令> [参数...]" >&2; exit 1; fi
cmd=$(printf '%q ' "$@")
printf '\\033]777;gui;%s;%s\\007' "$(printf '%s' "$cmd" | base64 -w0)" "$(pwd | base64 -w0)"
`;

// wd-clip.py：X11 多目标剪贴板桥接工具（同时提供 image/png、x-special/gnome-copied-files、text/uri-list、UTF8_STRING）
const WD_CLIP_PY = `#!/usr/bin/env python3
import sys, os, json, time, urllib.parse, gi
gi.require_version('Gtk', '3.0')
from gi.repository import Gtk, Gdk, GLib

def parse_uri_list(raw_bytes):
    text = raw_bytes.decode("utf-8", errors="replace")
    lines = [l.strip() for l in text.splitlines() if l.strip() and not l.strip().startswith("#")]
    cut = False
    if lines and lines[0] in ("copy", "cut"):
        cut = (lines[0] == "cut")
        lines = lines[1:]
    paths = []
    for u in lines:
        if u.startswith("file://"):
            p = urllib.parse.unquote(u[7:])
            if p.startswith("localhost/"):
                p = p[9:]
            if p and os.path.exists(p):
                paths.append(p)
    return paths, cut

def do_get():
    cb = Gtk.Clipboard.get(Gdk.SELECTION_CLIPBOARD)
    ok, targets = cb.wait_for_targets()
    target_names = [t.name() for t in (targets or [])] if ok else []

    for atom_name in ("x-special/gnome-copied-files", "x-special/mate-copied-files", "text/uri-list"):
        if atom_name in target_names:
            sel = cb.wait_for_contents(Gdk.Atom.intern(atom_name, False))
            if sel is not None:
                data = sel.get_data()
                if data:
                    paths, cut = parse_uri_list(data)
                    if paths:
                        sys.stdout.write(json.dumps({"kind": "files", "paths": paths, "cut": cut}) + "\\n")
                        return

    if "image/png" in target_names or cb.wait_is_image_available():
        sel = cb.wait_for_contents(Gdk.Atom.intern("image/png", False))
        if sel is not None and sel.get_data():
            out_dir = "/tmp/wd-clip-files"
            os.makedirs(out_dir, exist_ok=True)
            out_file = os.path.join(out_dir, f"vnc-clip-{int(time.time() * 1000)}.png")
            with open(out_file, "wb") as f:
                f.write(sel.get_data())
            sys.stdout.write(json.dumps({"kind": "image", "paths": [out_file], "pngPath": out_file, "cut": False}) + "\\n")
            return
        pixbuf = cb.wait_for_image()
        if pixbuf is not None:
            out_dir = "/tmp/wd-clip-files"
            os.makedirs(out_dir, exist_ok=True)
            out_file = os.path.join(out_dir, f"vnc-clip-{int(time.time() * 1000)}.png")
            pixbuf.savev(out_file, "png", [], [])
            sys.stdout.write(json.dumps({"kind": "image", "paths": [out_file], "pngPath": out_file, "cut": False}) + "\\n")
            return

    txt = cb.wait_for_text()
    if txt:
        sys.stdout.write(json.dumps({"kind": "text", "text": txt, "paths": [], "cut": False}) + "\\n")
        return

    sys.stdout.write(json.dumps({"kind": "empty", "paths": [], "cut": False}) + "\\n")

def do_set():
    raw = sys.stdin.read()
    cfg = json.loads(raw) if raw.strip() else {}
    paths = [p for p in cfg.get("paths", []) if isinstance(p, str) and p]
    action = "cut" if cfg.get("cut") else "copy"
    png_path = cfg.get("pngPath")
    text_val = cfg.get("text", "")

    png_bytes = None
    if png_path and os.path.isfile(png_path):
        try:
            with open(png_path, "rb") as f:
                png_bytes = f.read()
        except Exception:
            png_bytes = None

    uris = ["file://" + urllib.parse.quote(p) for p in paths]
    uri_list = ("\\r\\n".join(uris) + "\\r\\n").encode("utf-8") if uris else b""
    gnome_files = (action + "\\n" + "\\n".join(uris)).encode("utf-8") if uris else b""
    utf8_bytes = text_val.encode("utf-8") if isinstance(text_val, str) else b""

    sel_atom = Gdk.Atom.intern("CLIPBOARD", False)
    w = Gtk.Invisible()
    w.realize()
    Gtk.selection_owner_set(w, sel_atom, Gdk.CURRENT_TIME)

    if png_bytes:
        Gtk.selection_add_target(w, sel_atom, Gdk.Atom.intern("image/png", False), 1)
    if uris:
        Gtk.selection_add_target(w, sel_atom, Gdk.Atom.intern("x-special/gnome-copied-files", False), 2)
        Gtk.selection_add_target(w, sel_atom, Gdk.Atom.intern("x-special/mate-copied-files", False), 2)
        Gtk.selection_add_target(w, sel_atom, Gdk.Atom.intern("text/uri-list", False), 3)
    if utf8_bytes:
        for t in ["UTF8_STRING", "text/plain;charset=utf-8", "text/plain", "STRING", "TEXT"]:
            Gtk.selection_add_target(w, sel_atom, Gdk.Atom.intern(t, False), 4)

    def on_get(widget, sel, info, time_val):
        target = sel.get_target()
        if info == 1 and png_bytes:
            sel.set(target, 8, png_bytes)
        elif info == 2 and gnome_files:
            sel.set(target, 8, gnome_files)
        elif info == 3 and uri_list:
            sel.set(target, 8, uri_list)
        elif info == 4 and utf8_bytes:
            sel.set(target, 8, utf8_bytes)

    def on_clear(widget, ev):
        if getattr(ev, "selection", None) == sel_atom:
            Gtk.main_quit()

    w.connect("selection-get", on_get)
    w.connect("selection-clear-event", on_clear)
    Gdk.flush()
    sys.stdout.write("READY\\n")
    sys.stdout.flush()
    GLib.timeout_add_seconds(7200, Gtk.main_quit)
    Gtk.main()

if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--get":
        do_get()
    else:
        do_set()
`;

// 自定义 rcfile：先加载系统与用户的配置，最后再把 ~/.webdesktop/bin 放进 PATH（系统配置可能会重置 PATH）
const RC_FILE = `# WebDesktop 终端初始化（自动生成）
[ -f /etc/bash.bashrc ] && . /etc/bash.bashrc
[ -f "$HOME/.bashrc" ] && . "$HOME/.bashrc"
case ":$PATH:" in *":$HOME/.webdesktop/bin:"*) ;; *) export PATH="$HOME/.webdesktop/bin:$PATH";; esac
`;

let binReady: Promise<string> | null = null;
export function ensureBin() {
  binReady ??= (async () => {
    const dir = path.join(HOME, ".webdesktop", "bin");
    try {
      await fsp.mkdir(dir, { recursive: true });
      const files: [string, string][] = [
        ["open", OPEN_SCRIPT],
        ["xdg-open", OPEN_SCRIPT],
        ["gui", GUI_SCRIPT],
        ["wd-clip.py", WD_CLIP_PY],
      ];
      for (const [n, body] of files) {
        const f = path.join(dir, n);
        await fsp.writeFile(f, body, { mode: 0o755 });
        await fsp.chmod(f, 0o755);
      }
      await fsp.writeFile(path.join(HOME, ".webdesktop", "bashrc"), RC_FILE);
    } catch {
      /* 非关键 */
    }
    return dir;
  })();
  return binReady;
}

export function cleanEnv(binDir: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (
      k === "DATABASE_URL" ||
      k === "NODE_ENV" ||
      k === "PORT" ||
      k === "INIT_CWD" ||
      k === "NODE" ||
      k === "AUTH_KEY" ||
      k === "ADMIN_PASSWORD" ||
      k.startsWith("npm_") ||
      k.startsWith("NEXT_") ||
      k.startsWith("__NEXT") ||
      k.startsWith("BROWSER_")
    ) {
      continue;
    }
    env[k] = v;
  }
  env.TERM = "xterm-256color";
  env.COLORTERM = "truecolor";
  env.HOME = HOME;
  env.LANG = process.env.LANG && /utf-?8/i.test(process.env.LANG) ? process.env.LANG : "C.UTF-8";
  env.PATH = `${binDir}:${process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"}`;
  env.WEBDESKTOP = "1";
  return env;
}
