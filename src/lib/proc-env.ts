import fsp from "fs/promises";
import path from "path";
import { HOME } from "@/lib/sys";

// 终端与图形应用共用：子进程环境变量，以及 ~/.webdesktop/bin 下的辅助命令（open / gui）。

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
