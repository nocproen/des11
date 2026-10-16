import { denyDesktop } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const denied = await denyDesktop(req);
  if (denied) return denied;
  return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}
