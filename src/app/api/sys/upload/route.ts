import { denyDesktop } from "@/lib/auth";
import { createWriteStream } from "fs";
import fsp from "fs/promises";
import path from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import type { ReadableStream as WebReadableStream } from "stream/web";
import { exists, fsError, resolveP, validName } from "@/lib/sys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_CHUNK = 16 * 1024 * 1024;

const bad = (error: string, status = 400) => Response.json({ error }, { status });

// 同名时像 Windows 一样改名：a.png → a (2).png
async function uniquePath(dir: string, name: string) {
  let p = path.join(dir, name);
  if (!(await exists(p))) return p;
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let i = 2; ; i++) {
    p = path.join(dir, `${stem} (${i})${ext}`);
    if (!(await exists(p))) return p;
  }
}

// 把网页上粘贴 / 拖进来的文件写到服务器目录。按块上传：
//   POST /api/sys/upload?dir=目标目录&name=相对路径(可含子目录)&id=上传编号&offset=本块起点[&done=1]
// 请求体就是这一块的原始字节。最后一块带 done=1，临时文件改成正式文件名（重名自动加 (2)）。
export async function POST(req: Request) {
  const denied = await denyDesktop(req);
  if (denied) return denied;
  const url = new URL(req.url);
  const id = url.searchParams.get("id") ?? "";
  const rel = url.searchParams.get("name") ?? "";
  // 空文件夹：只建目录
  if (url.searchParams.get("mkdir") === "1") {
    const segs = rel.split("/");
    if (!segs.every(validName)) return bad("文件名无效");
    try {
      const p = path.join(resolveP(url.searchParams.get("dir")), ...segs);
      await fsp.mkdir(p, { recursive: true });
      return Response.json({ path: p });
    } catch (e) {
      return fsError(e);
    }
  }
  const offset = Number(url.searchParams.get("offset") ?? "0");
  const done = url.searchParams.get("done") === "1";
  if (!/^[a-z0-9]{8,40}$/.test(id) || !Number.isSafeInteger(offset) || offset < 0) return bad("参数无效");
  const parts = rel.split("/");
  if (!parts.every(validName)) return bad("文件名无效");
  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > MAX_CHUNK) return bad("分块过大", 413);

  try {
    const root = resolveP(url.searchParams.get("dir"));
    if (!(await fsp.stat(root)).isDirectory()) return bad("目标不是目录");
    const dir = path.join(root, ...parts.slice(0, -1));
    await fsp.mkdir(dir, { recursive: true });
    const tmp = path.join(dir, `.wd-upload-${id}.part`);

    if (offset === 0) await fsp.writeFile(tmp, "");
    else {
      const st = await fsp.stat(tmp).catch(() => null);
      if (!st) return bad("上传已中断，请重新粘贴", 409);
      if (st.size !== offset) await fsp.truncate(tmp, offset); // 上一块重试：丢掉写了一半的部分
    }
    if (req.body) {
      await pipeline(
        Readable.fromWeb(req.body as unknown as WebReadableStream<Uint8Array>),
        createWriteStream(tmp, { flags: "r+", start: offset }),
      );
    }
    if (!done) return Response.json({ ok: true });

    const dest = await uniquePath(dir, parts[parts.length - 1]);
    await fsp.rename(tmp, dest);
    return Response.json({ path: dest });
  } catch (e) {
    return fsError(e);
  }
}

// 放弃上传：删掉临时文件
export async function DELETE(req: Request) {
  const denied = await denyDesktop(req);
  if (denied) return denied;
  const url = new URL(req.url);
  const id = url.searchParams.get("id") ?? "";
  const parts = (url.searchParams.get("name") ?? "").split("/");
  if (!/^[a-z0-9]{8,40}$/.test(id) || !parts.every(validName)) return bad("参数无效");
  const dir = path.join(resolveP(url.searchParams.get("dir")), ...parts.slice(0, -1));
  await fsp.rm(path.join(dir, `.wd-upload-${id}.part`), { force: true }).catch(() => {});
  return Response.json({ ok: true });
}
