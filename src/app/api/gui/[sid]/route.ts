import { denyDesktop } from "@/lib/auth";
import { endedReason, getGui, openUrl, statusOf, stopGui } from "@/lib/gui";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ sid: string }> };

export async function GET(req: Request, ctx: Ctx) {
  const denied = await denyDesktop(req);
  if (denied) return denied;
  const { sid } = await ctx.params;
  const g = getGui(sid);
  // gone:true 是"我们自己的服务器确认这个会话没了"的明确标记；代理 / 网关返回的 404 不会带它，网页不能把那种 404 当成会话结束
  if (!g) return Response.json({ error: "会话不存在或已结束", gone: true, reason: endedReason(sid) }, { status: 404 });
  return Response.json(statusOf(g), { headers: { "Cache-Control": "no-store" } });
}

export async function DELETE(req: Request, ctx: Ctx) {
  const denied = await denyDesktop(req);
  if (denied) return denied;
  const { sid } = await ctx.params;
  stopGui(sid);
  return Response.json({ ok: true });
}

// 在这个浏览器会话里打开一个网址（新标签页）
export async function POST(req: Request, ctx: Ctx) {
  const denied = await denyDesktop(req);
  if (denied) return denied;
  const { sid } = await ctx.params;
  const g = getGui(sid);
  if (!g) return Response.json({ error: "会话不存在或已结束" }, { status: 404 });
  const b = (await req.json().catch(() => null)) as { url?: unknown } | null;
  if (!b || typeof b.url !== "string") return Response.json({ error: "参数无效" }, { status: 400 });
  try {
    await openUrl(g, b.url);
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "操作失败" }, { status: 400 });
  }
}
