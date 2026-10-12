import { denyDesktop } from "@/lib/auth";
import { dropFile, getGui } from "@/lib/gui";
import { fsError, resolveP } from "@/lib/sys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ sid: string }> };

// 把网页桌面 / 文件管理器里的文件拖到应用窗口上：{ path, x, y }，x / y 是远程屏幕上的坐标
export async function POST(req: Request, ctx: Ctx) {
  const denied = await denyDesktop(req);
  if (denied) return denied;
  const { sid } = await ctx.params;
  const g = getGui(sid);
  if (!g) return Response.json({ error: "会话不存在或已结束" }, { status: 404 });
  const b = (await req.json().catch(() => null)) as { path?: string; x?: number; y?: number } | null;
  if (!b || typeof b.path !== "string" || !Number.isFinite(b.x) || !Number.isFinite(b.y)) {
    return Response.json({ error: "参数无效" }, { status: 400 });
  }
  try {
    return Response.json(await dropFile(g, resolveP(b.path), Math.max(0, b.x!), Math.max(0, b.y!)));
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code) return fsError(e);
    return Response.json({ error: e instanceof Error ? e.message : "操作失败" }, { status: 400 });
  }
}
