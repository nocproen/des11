import { denyDesktop } from "@/lib/auth";
import fsp from "fs/promises";
import path from "path";
import { fsError, resolveP } from "@/lib/sys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  ico: "image/x-icon",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  mp4: "video/mp4",
  webm: "video/webm",
  txt: "text/plain; charset=utf-8",
};

const MAX = 100 * 1024 * 1024;

export async function GET(req: Request) {
  const denied = await denyDesktop(req);
  if (denied) return denied;
  const url = new URL(req.url);
  const p = resolveP(url.searchParams.get("path"));
  try {
    const st = await fsp.stat(p);
    if (st.isDirectory()) return Response.json({ error: "这是一个目录" }, { status: 400 });
    if (st.size > MAX) return Response.json({ error: "文件过大" }, { status: 413 });
    const buf = await fsp.readFile(p);
    const ext = path.extname(p).slice(1).toLowerCase();
    const mime = MIME[ext];
    const download = url.searchParams.get("download") === "1" || !mime;
    return new Response(new Uint8Array(buf), {
      headers: {
        "Content-Type": mime ?? "application/octet-stream",
        "Content-Length": String(buf.length),
        "Content-Disposition": `${download ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(path.basename(p))}`,
        "Content-Security-Policy": "sandbox",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    return fsError(e);
  }
}
