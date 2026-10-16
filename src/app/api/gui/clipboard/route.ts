import { denyDesktop } from "@/lib/auth";
import { getServerClip, readVncClipboard, setServerClipFiles } from "@/lib/gui";
import { fsError, resolveP } from "@/lib/sys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const denied = await denyDesktop(req);
  if (denied) return denied;
  const probeVnc = new URL(req.url).searchParams.get("probe") === "1";
  const clip = probeVnc ? await readVncClipboard() : getServerClip();
  return Response.json({ clip }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: Request) {
  const denied = await denyDesktop(req);
  if (denied) return denied;
  const b = (await req.json().catch(() => null)) as {
    paths?: unknown;
    cut?: unknown;
  } | null;
  if (!b || !Array.isArray(b.paths)) {
    return Response.json({ error: "参数无效" }, { status: 400 });
  }
  const rawPaths = b.paths.filter((p): p is string => typeof p === "string" && p.trim().length > 0);
  if (!rawPaths.length) {
    return Response.json({ error: "未选择文件" }, { status: 400 });
  }
  try {
    const resolved = rawPaths.map((p) => resolveP(p));
    const clip = await setServerClipFiles(resolved, !!b.cut);
    return Response.json({ ok: true, clip });
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code) return fsError(e);
    return Response.json({ error: e instanceof Error ? e.message : "复制失败" }, { status: 400 });
  }
}
