import { registerWindowSession } from "@/lib/session-lifecycle";
import { denyDesktop } from "@/lib/auth";
import { openShared } from "@/lib/desktop-sync";
import { closeSession, createSession, getSession, startingNote } from "@/lib/remote-browser";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// 会话是否还在（没有被关闭或崩溃）
const isAlive = (sid: string) => !!getSession(sid);

// 打开一个极速浏览器窗口。传入 key（窗口 id）时，同一个窗口在不同浏览器里共享同一个浏览器会话。
export async function POST(req: Request) {
  const denied = await denyDesktop(req);
  if (denied) return denied;
  const b = (await req.json().catch(() => null)) as { w?: number; h?: number; url?: string; key?: unknown } | null;
  const key = typeof b?.key === "string" ? b.key.slice(0, 64) : "";
  try {
    const make = async () => {
      const s = await createSession(Number(b?.w) || 900, Number(b?.h) || 520, b?.url);
      return { sid: s.id };
    };
    const sid = key
      ? (await openShared(`browser:${key}`, make, isAlive)).value.sid
      : (await make()).sid;
    if (key) registerWindowSession(key, "browser", () => { const session = getSession(sid); if (session) return closeSession(session); });
    return Response.json({ sid });
  } catch (e) {
    const note = startingNote();
    const msg = e instanceof Error ? e.message : "启动浏览器失败";
    return Response.json({ error: note ? `${note} ${msg}` : msg.slice(0, 400) }, { status: 500 });
  }
}
