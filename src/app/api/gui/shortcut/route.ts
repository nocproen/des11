import { denyDesktop } from "@/lib/auth";
import { createShortcut } from "@/lib/gui";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 把应用添加到桌面（复制一份启动文件到 ~/Desktop）
export async function POST(req: Request) {
  const denied = await denyDesktop(req);
  if (denied) return denied;
  const b = (await req.json().catch(() => null)) as { file?: unknown } | null;
  if (!b || typeof b.file !== "string") return Response.json({ error: "参数无效" }, { status: 400 });
  try {
    return Response.json({ path: await createShortcut(b.file) });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "操作失败" }, { status: 400 });
  }
}
