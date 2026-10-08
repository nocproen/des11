import { denyDesktop } from "@/lib/auth";
import { getSession, handleInput, touch } from "@/lib/remote-browser";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ sid: string }> }) {
  const denied = await denyDesktop(req);
  if (denied) return denied;
  const { sid } = await ctx.params;
  const s = getSession(sid);
  if (!s) return Response.json({ error: "会话已结束" }, { status: 404 });
  touch(s);
  const b = (await req.json().catch(() => null)) as { events?: Record<string, unknown>[] } | null;
  if (!b || !Array.isArray(b.events)) return Response.json({ error: "参数无效" }, { status: 400 });
  const out = await handleInput(s, b.events);
  return Response.json(out);
}
