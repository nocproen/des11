import { denyDesktop } from "@/lib/auth";
import { getSession, touch, waitFrame } from "@/lib/remote-browser";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ sid: string }> }) {
  const denied = await denyDesktop(req);
  if (denied) return denied;
  const { sid } = await ctx.params;
  const s = getSession(sid);
  if (!s) return Response.json({ error: "会话已结束" }, { status: 404 });
  touch(s);
  const seq = Number(new URL(req.url).searchParams.get("seq") ?? 0);
  const f = await waitFrame(s, seq, req.signal);
  if (!f) return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  return new Response(new Uint8Array(f.buf), {
    headers: {
      "Content-Type": "image/jpeg",
      "X-Seq": String(f.seq),
      "Cache-Control": "no-store",
    },
  });
}
