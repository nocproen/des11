import { denyDesktop } from "@/lib/auth";
import { closeSession, getSession } from "@/lib/remote-browser";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(_req: Request, ctx: { params: Promise<{ sid: string }> }) {
  const denied = await denyDesktop(_req);
  if (denied) return denied;
  const { sid } = await ctx.params;
  const s = getSession(sid);
  if (s) await closeSession(s);
  return Response.json({ ok: true });
}
