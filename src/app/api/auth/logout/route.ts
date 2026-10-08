import { DESKTOP_COOKIE, clearCookieHeader } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  return Response.json({ ok: true }, { headers: { "Set-Cookie": clearCookieHeader(DESKTOP_COOKIE, req) } });
}
