import { denyDesktop } from "@/lib/auth";
import { getGui, setClipboardImage } from "@/lib/gui";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_IMAGE = 32 * 1024 * 1024;

type Ctx = { params: Promise<{ sid: string }> };

// 把本机剪贴板里的图片放进远程应用的剪贴板（请求体就是图片本身）
export async function POST(req: Request, ctx: Ctx) {
  const denied = await denyDesktop(req);
  if (denied) return denied;
  const { sid } = await ctx.params;
  const g = getGui(sid);
  if (!g) return Response.json({ error: "会话不存在或已结束" }, { status: 404 });
  const mime = (req.headers.get("content-type") ?? "").split(";")[0].trim();
  const data = Buffer.from(await req.arrayBuffer());
  if (!data.length || data.length > MAX_IMAGE) return Response.json({ error: "图片为空或超过 32MB" }, { status: 400 });
  try {
    await setClipboardImage(g, data, mime);
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "操作失败" }, { status: 400 });
  }
}
