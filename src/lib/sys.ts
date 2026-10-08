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

请谨慎操作：这里的删除和命令都是真实生效的。
`;

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
