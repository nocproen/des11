import { denyDesktop } from "@/lib/auth";
import { spawn } from "child_process";
import { createReadStream } from "fs";
import fsp from "fs/promises";
import path from "path";
import { Readable } from "stream";
import { fsError, resolveP } from "@/lib/sys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 文件夹打包成 zip（边打包边发送）。用 Python 的 zipfile：中文文件名会带 UTF-8 标记，Windows 解压不乱码
const ZIP_PY = `
import os, sys, zipfile
root = sys.argv[1]
base = os.path.basename(root.rstrip("/")) or "root"
with zipfile.ZipFile(sys.stdout.buffer, "w", zipfile.ZIP_DEFLATED, allowZip64=True) as z:
    for d, dirs, files in os.walk(root):
        rel = os.path.join(base, os.path.relpath(d, root)) if d != root else base
        if not dirs and not files:
            z.writestr(zipfile.ZipInfo(rel.rstrip("/") + "/"), b"")
        for f in files:
            p = os.path.join(d, f)
            if os.path.isfile(p):
                try:
                    z.write(p, os.path.join(rel, f))
                except OSError:
                    pass
`;

const disposition = (name: string) => `attachment; filename*=UTF-8''${encodeURIComponent(name)}`;

// 下载到电脑：文件原样下载（不限大小，流式发送）；文件夹下载为 名称.zip
export async function GET(req: Request) {
  const denied = await denyDesktop(req);
  if (denied) return denied;
  const p = resolveP(new URL(req.url).searchParams.get("path"));
  try {
    const st = await fsp.stat(p);
    if (st.isDirectory()) {
      const proc = spawn("python3", ["-c", ZIP_PY, p], { stdio: ["ignore", "pipe", "ignore"] });
      req.signal.addEventListener("abort", () => proc.kill());
      return new Response(Readable.toWeb(proc.stdout) as ReadableStream, {
        headers: {
          "Content-Type": "application/zip",
          "Content-Disposition": disposition(`${path.basename(p) || "root"}.zip`),
          "Cache-Control": "no-store",
        },
      });
    }
    const stream = createReadStream(p);
    req.signal.addEventListener("abort", () => stream.destroy());
    return new Response(Readable.toWeb(stream) as ReadableStream, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(st.size),
        "Content-Disposition": disposition(path.basename(p)),
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    return fsError(e);
  }
}
