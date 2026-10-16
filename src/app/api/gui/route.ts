import { denyDesktop } from "@/lib/auth";
import { createGui } from "@/lib/gui";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 启动一个图形应用窗口：立即返回会话号，前端轮询状态直到就绪
export async function POST(req: Request) {
  const denied = await denyDesktop(req);
  if (denied) return denied;
  const b = (await req.json().catch(() => null)) as {
    exec?: unknown;
    desktopFile?: unknown;
    cwd?: unknown;
    name?: unknown;
    w?: unknown;
    h?: unknown;
    preset?: unknown;
    url?: unknown;
    sidHint?: unknown;
  } | null;
  if (!b) return Response.json({ error: "请求无效" }, { status: 400 });
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  const preset = str(b.preset) === "browser" ? "browser" : undefined;
  if (!preset && !str(b.exec) && !str(b.desktopFile)) return Response.json({ error: "缺少要运行的命令" }, { status: 400 });
  try {
    const { g, reused } = await createGui({
      preset,
      url: str(b.url),
      sidHint: str(b.sidHint),
      exec: str(b.exec),
      desktopFile: str(b.desktopFile),
      cwd: str(b.cwd),
      name: str(b.name),
      w: Number(b.w),
      h: Number(b.h),
    });
    return Response.json({ sid: g.id, name: g.name, reused });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "启动失败";
    return Response.json({ error: msg }, { status: /过多/.test(msg) ? 429 : 400 });
  }
}
