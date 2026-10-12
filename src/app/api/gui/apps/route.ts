import { denyDesktop } from "@/lib/auth";
import { listApps } from "@/lib/gui";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const denied = await denyDesktop(req);
  if (denied) return denied;
  const { apps, desktop } = await listApps();
  const slim = (e: (typeof apps)[number]) => ({ file: e.file, name: e.name, icon: e.icon, comment: e.comment, exec: e.exec });
  return Response.json({ apps: apps.map(slim), desktop: desktop.map(slim) }, { headers: { "Cache-Control": "no-store" } });
}
