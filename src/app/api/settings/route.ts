import { publishChange } from "@/lib/change-events";
import { denyDesktop } from "@/lib/auth";
import { db } from "@/db";
import { desktopSettings } from "@/db/schema";

export const dynamic = "force-dynamic";

const changed = (body: object) => {
  publishChange("settings");
  return Response.json(body);
};

const ALLOWED = new Set(["wallpaper", "accent", "clock24", "customWallpaper"]);

export async function PUT(req: Request) {
  const denied = await denyDesktop(req);
  if (denied) return denied;
  const body = (await req.json().catch(() => null)) as { key?: string; value?: string } | null;
  if (
    !body ||
    typeof body.key !== "string" ||
    typeof body.value !== "string" ||
    !ALLOWED.has(body.key) ||
    body.value.length > 2000
  ) {
    return Response.json({ error: "设置无效" }, { status: 400 });
  }
  await db
    .insert(desktopSettings)
    .values({ key: body.key, value: body.value })
    .onConflictDoUpdate({ target: desktopSettings.key, set: { value: body.value } });
  return changed({ ok: true });
}
