import { denyDesktop } from "@/lib/auth";
import { commit, getShared } from "@/lib/desktop-sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 读取共享的桌面状态（窗口布局）
export async function GET(req: Request) {
  const denied = await denyDesktop(req);
  if (denied) return denied;
  return Response.json(await getShared(), { headers: { "Cache-Control": "no-store" } });
}

// 提交本浏览器的桌面状态改动；服务器保存并推送给其他浏览器
export async function POST(req: Request) {
  const denied = await denyDesktop(req);
  if (denied) return denied;
  const b = (await req.json().catch(() => null)) as { state?: unknown; base?: unknown; cid?: unknown } | null;
  if (!b) return Response.json({ error: "请求无效" }, { status: 400 });
  const origin = typeof b.cid === "string" ? b.cid.slice(0, 64) : "";
  const result = await commit(b.state, origin, b.base);
  if (result === null) return Response.json({ error: "桌面状态无效" }, { status: 400 });
  return Response.json(result, { headers: { "Cache-Control": "no-store" } });
}
