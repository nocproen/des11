import fsp from "fs/promises";
import path from "path";
import { denyDesktop } from "@/lib/auth";
import { findIcon } from "@/lib/gui";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TYPES: Record<string, string> = {
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
};

export async function GET(req: Request) {
  const denied = await denyDesktop(req);
  if (denied) return denied;
  const name = new URL(req.url).searchParams.get("name") ?? "";
  const file = await findIcon(name);
  if (!file) return new Response(null, { status: 404 });
  try {
    const st = await fsp.stat(file);
    if (st.size > 2 * 1024 * 1024) return new Response(null, { status: 404 });
    const buf = await fsp.readFile(file);
    return new Response(new Uint8Array(buf), {
      headers: {
        "Content-Type": TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream",
        "Cache-Control": "private, max-age=3600",
        "Content-Security-Policy": "sandbox",
      },
    });
  } catch {
    return new Response(null, { status: 404 });
  }
}
