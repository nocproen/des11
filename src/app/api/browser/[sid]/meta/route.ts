import { denyDesktop } from "@/lib/auth";
import { getSession, touch, waitMeta } from "@/lib/remote-browser";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ sid: string }> }) {
  const denied = await denyDesktop(req);
  if (denied) return denied;
  const { sid } = await ctx.params;
  const s = getSession(sid);
  if (!s) return Response.json({ error: "会话已结束" }, { status: 404 });
  touch(s);
  const v = Number(new URL(req.url).searchParams.get("v") ?? 0);
  const m = await waitMeta(s, v, req.signal);
  touch(s);
  return Response.json(m, { headers: { "Cache-Control": "no-store" } });
}
