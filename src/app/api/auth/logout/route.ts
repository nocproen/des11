import { DESKTOP_COOKIE, clearCookieHeader, denyDesktop } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const denied = await denyDesktop(req);
  if (denied) return denied;
  return Response.json({ ok: true }, { headers: { "Set-Cookie": clearCookieHeader(DESKTOP_COOKIE, req), "Cache-Control": "no-store" } });
}
