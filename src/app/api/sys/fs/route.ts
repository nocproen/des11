import { denyDesktop } from "@/lib/auth";
import fsp from "fs/promises";
import path from "path";
import { readVncClipboard } from "@/lib/gui";
import {
  copyEntryToDir,
  destroyTrashed,
  emptyTrash,
  ensureHome,
  exists,
  fsError,
  isInTrash,
  isProtected,
  listDir,
  moveToTrash,
  movePath,
  resolveP,
  restoreFromTrash,
  validName,
} from "@/lib/sys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_READ = 2 * 1024 * 1024;
const MAX_WRITE = 5 * 1024 * 1024;

const bad = (error: string, status = 400) => Response.json({ error }, { status });

export async function GET(req: Request) {
  const denied = await denyDesktop(req);
  if (denied) return denied;
  await ensureHome();
  const url = new URL(req.url);
  const p = resolveP(url.searchParams.get("path"));
  try {
    const st = await fsp.stat(p);
    if (url.searchParams.get("read") === "1") {
      if (st.isDirectory()) return bad("这是一个目录");
      const base = { path: p, name: path.basename(p), size: st.size, mtime: st.mtimeMs };
      if (st.size > MAX_READ) {
        return Response.json({ ...base, tooLarge: true, binary: false, content: "" });
      }
      const buf = await fsp.readFile(p);
      const binary = buf.subarray(0, 8000).includes(0);
      return Response.json({
        ...base,
        tooLarge: false,
        binary,
        content: binary ? "" : buf.toString("utf8"),
      });
    }
    if (!st.isDirectory()) return bad("不是目录");
    const entries = await listDir(p, url.searchParams.get("hidden") !== "0");
    return Response.json({ path: p, parent: p === "/" ? null : path.dirname(p), entries });
  } catch (e) {
    return fsError(e);
  }
}

// 新建文件 / 文件夹
export async function POST(req: Request) {
  const denied = await denyDesktop(req);
  if (denied) return denied;
  const b = (await req.json().catch(() => null)) as {
    dir?: string;
    name?: string;
    kind?: string;
    content?: string;
  } | null;
  if (!b || !validName(b.name) || (b.kind !== "folder" && b.kind !== "file")) return bad("参数无效");
  const dir = resolveP(b.dir);
  const target = path.join(dir, b.name);
  try {
    if (b.kind === "folder") await fsp.mkdir(target);
    else {
      const content = typeof b.content === "string" ? b.content : "";
      if (content.length > MAX_WRITE) return bad("内容过大", 413);
      await fsp.writeFile(target, content, { flag: "wx" });
    }
    return Response.json({ path: target });
  } catch (e) {
    return fsError(e);
  }
}

// 写入文件内容
export async function PUT(req: Request) {
  const denied = await denyDesktop(req);
  if (denied) return denied;
  const b = (await req.json().catch(() => null)) as { path?: string; content?: string } | null;
  if (!b || typeof b.path !== "string" || typeof b.content !== "string") return bad("参数无效");
  if (b.content.length > MAX_WRITE) return bad("内容过大", 413);
  const p = resolveP(b.path);
  try {
    const st = await fsp.stat(p);
    if (st.isDirectory()) return bad("这是一个目录");
    await fsp.writeFile(p, b.content);
    return Response.json({ ok: true });
  } catch (e) {
    return fsError(e);
  }
}

// 重命名 / 移动 / 复制粘贴 / 从回收站还原
export async function PATCH(req: Request) {
  const denied = await denyDesktop(req);
  if (denied) return denied;
  const b = (await req.json().catch(() => null)) as {
    path?: string;
    name?: string;
    moveTo?: string;
    restore?: boolean;
    copyPaths?: string[];
    destDir?: string;
    cut?: boolean;
    pasteFromVnc?: boolean;
  } | null;
  if (!b) return bad("参数无效");

  if (typeof b.destDir === "string" && (Array.isArray(b.copyPaths) || b.pasteFromVnc)) {
    const destDir = resolveP(b.destDir);
    try {
      let srcPaths = Array.isArray(b.copyPaths)
        ? b.copyPaths.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => resolveP(x))
        : [];
      let cut = !!b.cut;
      if (!srcPaths.length && b.pasteFromVnc) {
        const vncClip = await readVncClipboard();
        if (vncClip && vncClip.paths.length) {
          srcPaths = vncClip.paths;
          cut = vncClip.cut;
        }
      }
      if (!srcPaths.length) return bad("剪贴板中没有可粘贴的文件", 400);
      const created: string[] = [];
      for (const s of srcPaths) {
        created.push(await copyEntryToDir(s, destDir, cut));
      }
      return Response.json({ paths: created, count: created.length, cut });
    } catch (e) {
      return fsError(e);
    }
  }

  if (typeof b.path !== "string") return bad("参数无效");
  const src = resolveP(b.path);
  try {
    if (isProtected(src)) return bad("受保护的系统路径，不能修改", 403);
    if (b.restore) {
      if (!isInTrash(src)) return bad("该项目不在回收站中");
      const dest = await restoreFromTrash(src);
      return Response.json({ path: dest });
    }
    let dest: string;
    if (typeof b.name === "string") {
      if (!validName(b.name)) return bad("名称无效");
      dest = path.join(path.dirname(src), b.name);
    } else if (typeof b.moveTo === "string") {
      const dir = resolveP(b.moveTo);
      const st = await fsp.stat(dir);
      if (!st.isDirectory()) return bad("目标不是目录");
      dest = path.join(dir, path.basename(src));
      if (dest === src) return Response.json({ path: dest });
    } else return bad("参数无效");
    if (dest === src) return Response.json({ path: dest });
    if (dest.startsWith(src + path.sep)) return bad("不能把目录移动到它自己里面");
    if (await exists(dest)) return bad("目标位置已存在同名文件", 409);
    await movePath(src, dest);
    return Response.json({ path: dest });
  } catch (e) {
    return fsError(e);
  }
}

// 默认移入回收站；回收站内的项目或 permanent=1 则永久删除
export async function DELETE(req: Request) {
  const denied = await denyDesktop(req);
  if (denied) return denied;
  const url = new URL(req.url);
  try {
    if (url.searchParams.get("emptyTrash") === "1") {
      await emptyTrash();
      return Response.json({ ok: true });
    }
    const p = resolveP(url.searchParams.get("path"));
    if (isProtected(p)) return bad("受保护的系统路径，不能删除", 403);
    await fsp.lstat(p);
    if (isInTrash(p)) {
      await destroyTrashed(p);
      return Response.json({ deleted: true });
    }
    if (url.searchParams.get("permanent") === "1") {
      await fsp.rm(p, { recursive: true, force: true });
      return Response.json({ deleted: true });
    }
    await moveToTrash(p);
    return Response.json({ trashed: true });
  } catch (e) {
    return fsError(e);
  }
}
