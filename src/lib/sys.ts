import os from "os";
import path from "path";
import fsp from "fs/promises";

export const HOME = process.env.HOME || os.homedir();
export const DESKTOP = path.join(HOME, "Desktop");
export const DOCUMENTS = path.join(HOME, "Documents");
export const DOWNLOADS = path.join(HOME, "Downloads");
export const PICTURES = path.join(HOME, "Pictures");
export const TRASH_ROOT = path.join(HOME, ".local/share/Trash");
export const TRASH_FILES = path.join(TRASH_ROOT, "files");
export const TRASH_INFO = path.join(TRASH_ROOT, "info");

export function resolveP(p?: string | null) {
  if (!p || p === "~") return HOME;
  if (p.startsWith("~/")) return path.join(HOME, p.slice(2));
  return path.resolve(p);
}

const WELCOME = `欢迎来到真实系统桌面！

这个系统原本没有桌面环境，现在网页把它"画"出来了：

  • 你现在看到的桌面图标，就是服务器上真实目录 ${DESKTOP} 里的内容
  • "文件管理器"浏览的是服务器真实的文件系统（/、/etc、/var ……）
  • "终端"是真实的 bash，命令直接在服务器上执行
  • "系统监视器"读取的是 /proc 里真实的 CPU、内存、进程信息
  • 在桌面上新建、删除、拖动文件，服务器上的文件会同步变化

【VNC 文件与图片复制粘贴指南】
  1. 在模拟桌面或文件管理器上右键「示例图片.png」（或任意文件）点击「复制」或按 Ctrl+C
  2. 打开任意 VNC 应用（如「浏览器」或桌面上的「VNC 文件管理器」），在窗口内按 Ctrl+V、右键粘贴、或点击窗口右下角「📋」按钮，即可直接粘贴图片或文件
  3. 也可以直接把桌面上的图片或文件拖拽到 VNC 窗口内松手自动粘贴

请谨慎操作：这里的删除和命令都是真实生效的。
`;

const SAMPLE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400" viewBox="0 0 640 400">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#0f172a"/>
      <stop offset="50%" stop-color="#1e3a8a"/>
      <stop offset="100%" stop-color="#047857"/>
    </linearGradient>
    <linearGradient id="accent" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#38bdf8"/>
      <stop offset="100%" stop-color="#34d399"/>
    </linearGradient>
  </defs>
  <rect width="640" height="400" rx="24" fill="url(#bg)"/>
  <circle cx="520" cy="90" r="110" fill="#38bdf8" fill-opacity="0.14"/>
  <circle cx="120" cy="330" r="130" fill="#34d399" fill-opacity="0.14"/>
  <rect x="44" y="44" width="552" height="312" rx="18" fill="#0f172a" fill-opacity="0.55" stroke="#ffffff" stroke-opacity="0.18" stroke-width="2"/>
  <rect x="76" y="84" width="96" height="96" rx="20" fill="url(#accent)"/>
  <text x="124" y="148" font-family="DejaVu Sans, Noto Sans CJK SC, sans-serif" font-size="44" font-weight="bold" fill="#0f172a" text-anchor="middle">VNC</text>
  <text x="200" y="122" font-family="DejaVu Sans, Noto Sans CJK SC, sans-serif" font-size="28" font-weight="bold" fill="#f8fafc">桌面示例图片 · Sample Image</text>
  <text x="200" y="160" font-family="DejaVu Sans, Noto Sans CJK SC, sans-serif" font-size="17" fill="#cbd5e1">支持复制粘贴到 VNC 应用 / 浏览器 / 文件管理器</text>
  <rect x="76" y="212" width="488" height="2" fill="url(#accent)" fill-opacity="0.5"/>
  <text x="76" y="256" font-family="DejaVu Sans, Noto Sans CJK SC, sans-serif" font-size="16" fill="#94a3b8">• 右键此图片选择「复制」或「复制图片」，或选中后按 Ctrl+C</text>
  <text x="76" y="288" font-family="DejaVu Sans, Noto Sans CJK SC, sans-serif" font-size="16" fill="#94a3b8">• 在 VNC 窗口中按 Ctrl+V、点右下角 📋 按钮、或直接拖入窗口</text>
  <text x="76" y="320" font-family="DejaVu Sans, Noto Sans CJK SC, sans-serif" font-size="14" fill="#38bdf8">MIME: image/png + text/uri-list + x-special/gnome-copied-files</text>
</svg>`;

const VNC_FM_DESKTOP = `[Desktop Entry]
Type=Application
Name=VNC 文件管理器
Name[zh_CN]=VNC 文件管理器
Comment=在 VNC 窗口中运行 PCManFM，可测试直接粘贴桌面复制的文件或图片
Exec=pcmanfm ${DOCUMENTS}
Icon=system-file-manager
Terminal=false
`;

async function ensureSampleAssets() {
  const samplePng = path.join(DESKTOP, "示例图片.png");
  try {
    await fsp.access(samplePng);
  } catch {
    try {
      const sharp = (await import("sharp")).default;
      const pngBuf = await sharp(Buffer.from(SAMPLE_SVG)).png().toBuffer();
      await fsp.writeFile(samplePng, pngBuf);
      await fsp.writeFile(path.join(PICTURES, "示例图片.png"), pngBuf).catch(() => {});
    } catch {
      /* ignore */
    }
  }
  const fmLauncher = path.join(DESKTOP, "VNC文件管理器.desktop");
  try {
    await fsp.access(fmLauncher);
  } catch {
    await fsp.writeFile(fmLauncher, VNC_FM_DESKTOP, { mode: 0o755 }).catch(() => {});
    await fsp.chmod(fmLauncher, 0o755).catch(() => {});
  }
}

let ensured: Promise<void> | null = null;
export function ensureHome() {
  ensured ??= (async () => {
    try {
      for (const d of [DESKTOP, DOCUMENTS, DOWNLOADS, PICTURES, TRASH_FILES, TRASH_INFO]) {
        await fsp.mkdir(d, { recursive: true });
      }
      const marker = path.join(HOME, ".webdesktop-seeded");
      try {
        await fsp.access(marker);
      } catch {
        await fsp.writeFile(path.join(DESKTOP, "欢迎使用.txt"), WELCOME, { flag: "wx" }).catch(() => {});
        await fsp.writeFile(marker, new Date().toISOString());
      }
      await ensureSampleAssets();
    } catch (e) {
      console.error("ensureHome failed", e);
    }
  })();
  return ensured;
}

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

export async function listDir(dir: string, hidden: boolean): Promise<SysEntry[]> {
  const names = (await fsp.readdir(dir)).slice(0, 4000);
  const rows = await Promise.all(
    names
      .filter((n) => hidden || !n.startsWith("."))
      .map(async (name): Promise<SysEntry | null> => {
        const full = path.join(dir, name);
        try {
          const ls = await fsp.lstat(full);
          let st = ls;
          const link = ls.isSymbolicLink();
          if (link) {
            try {
              st = await fsp.stat(full);
            } catch {
              /* 断开的链接 */
            }
          }
          return {
            name,
            path: full,
            kind: st.isDirectory() ? "folder" : "file",
            link,
            size: st.size,
            mtime: st.mtimeMs,
            mode: (st.mode & 0o777).toString(8).padStart(3, "0"),
            hidden: name.startsWith("."),
          };
        } catch {
          return null;
        }
      }),
  );
  return rows
    .filter((r): r is SysEntry => r !== null)
    .sort((a, b) =>
      a.kind !== b.kind ? (a.kind === "folder" ? -1 : 1) : a.name.localeCompare(b.name, "zh"),
    );
}

// 禁止对关键路径做删除 / 重命名 / 移动
export function isProtected(p: string) {
  const parts = p.split(path.sep).filter(Boolean);
  if (parts.length <= 1) return true;
  const fixed = [
    HOME,
    DESKTOP,
    DOCUMENTS,
    DOWNLOADS,
    PICTURES,
    TRASH_ROOT,
    TRASH_FILES,
    TRASH_INFO,
    path.join(HOME, ".local"),
    path.join(HOME, ".local/share"),
  ];
  if (fixed.includes(p)) return true;
  const cwd = process.cwd();
  if (cwd === p || cwd.startsWith(p + path.sep)) return true; // 运行本网站的目录
  if (HOME.startsWith(p + path.sep)) return true;
  return false;
}

export function isInTrash(p: string) {
  return p.startsWith(TRASH_FILES + path.sep);
}

export async function exists(p: string) {
  try {
    await fsp.lstat(p);
    return true;
  } catch {
    return false;
  }
}

export async function movePath(src: string, dst: string) {
  try {
    await fsp.rename(src, dst);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EXDEV") {
      await fsp.cp(src, dst, { recursive: true, preserveTimestamps: true });
      await fsp.rm(src, { recursive: true, force: true });
    } else throw e;
  }
}

/** 生成目标目录中不重名的文件路径（例如 "示例图片 - 副本.png" 或 "示例图片 (2).png"） */
export async function uniqueDestPath(destDir: string, baseNameStr: string, sameDirCopy = false): Promise<string> {
  const ext = path.extname(baseNameStr);
  const stem = ext ? baseNameStr.slice(0, -ext.length) : baseNameStr;
  const firstCandidate = sameDirCopy ? path.join(destDir, `${stem} - 副本${ext}`) : path.join(destDir, baseNameStr);
  if (!(await exists(firstCandidate))) return firstCandidate;
  for (let i = 2; i < 1000; i++) {
    const candidate = sameDirCopy
      ? path.join(destDir, `${stem} - 副本 (${i})${ext}`)
      : path.join(destDir, `${stem} (${i})${ext}`);
    if (!(await exists(candidate))) return candidate;
  }
  return path.join(destDir, `${stem}-${Date.now()}${ext}`);
}

/** 复制或剪切（移动）文件/文件夹到目标目录 */
export async function copyEntryToDir(src: string, destDir: string, cut = false): Promise<string> {
  const st = await fsp.lstat(src);
  const dirStat = await fsp.stat(destDir);
  if (!dirStat.isDirectory()) throw new Error("目标不是目录");

  const srcDir = path.dirname(src);
  const base = path.basename(src);
  if (cut && srcDir === destDir) return src;
  if (st.isDirectory() && (destDir === src || destDir.startsWith(src + path.sep))) {
    throw new Error("不能把文件夹复制或移动到它自己里面");
  }

  const dst = await uniqueDestPath(destDir, base, !cut && srcDir === destDir);
  if (cut) {
    if (isProtected(src)) throw new Error("受保护的系统路径，不能移动");
    await movePath(src, dst);
  } else {
    await fsp.cp(src, dst, { recursive: true, preserveTimestamps: true });
  }
  return dst;
}

export async function moveToTrash(p: string) {
  await ensureHome();
  const base = path.basename(p);
  let name = base;
  if (await exists(path.join(TRASH_FILES, name))) name = `${base}.${Date.now()}`;
  await movePath(p, path.join(TRASH_FILES, name));
  await fsp.writeFile(
    path.join(TRASH_INFO, name + ".json"),
    JSON.stringify({ original: p, deletedAt: Date.now() }),
  );
}

export async function restoreFromTrash(p: string) {
  const name = path.basename(p);
  let original = path.join(DOCUMENTS, name);
  try {
    const info = JSON.parse(await fsp.readFile(path.join(TRASH_INFO, name + ".json"), "utf8"));
    if (typeof info.original === "string") original = info.original;
  } catch {
    /* 没有记录则还原到 Documents */
  }
  await fsp.mkdir(path.dirname(original), { recursive: true });
  let dest = original;
  if (await exists(dest)) dest = `${original} (已还原)`;
  await movePath(p, dest);
  await fsp.rm(path.join(TRASH_INFO, name + ".json"), { force: true });
  return dest;
}

export async function destroyTrashed(p: string) {
  await fsp.rm(p, { recursive: true, force: true });
  await fsp.rm(path.join(TRASH_INFO, path.basename(p) + ".json"), { force: true });
}

export async function emptyTrash() {
  await ensureHome();
  for (const n of await fsp.readdir(TRASH_FILES)) {
    await fsp.rm(path.join(TRASH_FILES, n), { recursive: true, force: true });
  }
  for (const n of await fsp.readdir(TRASH_INFO)) {
    await fsp.rm(path.join(TRASH_INFO, n), { recursive: true, force: true });
  }
}

export function fsError(e: unknown) {
  const code = (e as NodeJS.ErrnoException)?.code;
  const map: Record<string, [number, string]> = {
    ENOENT: [404, "路径不存在"],
    EACCES: [403, "权限不足"],
    EPERM: [403, "操作不被允许"],
    EEXIST: [409, "同名文件已存在"],
    ENOTDIR: [400, "不是目录"],
    EISDIR: [400, "这是一个目录"],
    ENOTEMPTY: [409, "目录非空"],
    ENOSPC: [507, "磁盘空间不足"],
    EROFS: [403, "只读文件系统"],
  };
  const m = code ? map[code] : undefined;
  if (m) return Response.json({ error: m[1] }, { status: m[0] });
  return Response.json({ error: e instanceof Error ? e.message : "操作失败" }, { status: 500 });
}

export function validName(name: unknown): name is string {
  return (
    typeof name === "string" &&
    name.length > 0 &&
    name.length <= 255 &&
    !name.includes("/") &&
    !name.includes("\0") &&
    name !== "." &&
    name !== ".."
  );
}
