import { denyDesktop } from "@/lib/auth";
import { createSession, startingNote } from "@/lib/remote-browser";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: Request) {
  const denied = await denyDesktop(req);
  if (denied) return denied;
  const b = (await req.json().catch(() => null)) as { w?: number; h?: number; url?: string; urls?: unknown; activeIndex?: number } | null;
  try {
    const urls = Array.isArray(b?.urls) ? b.urls.filter((u: unknown): u is string => typeof u === "string" && u.length < 2048 && (u === "about:blank" || /^https?:\/\//i.test(u))).slice(0, 10) : undefined;
    const s = await createSession(Number(b?.w) || 900, Number(b?.h) || 520, b?.url, urls, b?.activeIndex);
    return Response.json({ sid: s.id });
  } catch (e) {
    const note = startingNote();
    const msg = e instanceof Error ? e.message : "启动浏览器失败";
    return Response.json({ error: note ? `${note} ${msg}` : msg.slice(0, 400) }, { status: 500 });
  }
}
