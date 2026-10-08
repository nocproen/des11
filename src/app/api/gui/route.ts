import { registerWindowSession } from "@/lib/session-lifecycle";
import { denyDesktop } from "@/lib/auth";
import { openShared } from "@/lib/desktop-sync";
import { createGui, getGui, stopGui } from "@/lib/gui";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 会话是否还能用（没有结束、没有失败）
const isGuiAlive = (sid: string) => {
  const g = getGui(sid);
  return !!g && !g.stopped && g.state !== "exited" && g.state !== "failed";
};

// 启动一个图形应用窗口：立即返回会话号，前端轮询状态直到就绪。
// 传入 key（窗口 id）时，同一个窗口在不同浏览器里会共享同一个会话（同一个画面）。
export async function POST(req: Request) {
  const denied = await denyDesktop(req);
  if (denied) return denied;
  const b = (await req.json().catch(() => null)) as {
    key?: unknown;
    exec?: unknown;
    desktopFile?: unknown;
    cwd?: unknown;
    name?: unknown;
    w?: unknown;
    h?: unknown;
    preset?: unknown;
    url?: unknown;
  } | null;
  if (!b) return Response.json({ error: "请求无效" }, { status: 400 });
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  const preset = str(b.preset) === "browser" ? "browser" : undefined;
  if (!preset && !str(b.exec) && !str(b.desktopFile)) return Response.json({ error: "缺少要运行的命令" }, { status: 400 });
  const key = str(b.key)?.slice(0, 64);
  const make = async () => {
    const { g, reused } = await createGui({
      preset,
      url: str(b.url),
      exec: str(b.exec),
      desktopFile: str(b.desktopFile),
      cwd: str(b.cwd),
      name: str(b.name),
      w: Number(b.w),
      h: Number(b.h),
    });
    return { sid: g.id, name: g.name, reused };
  };
  try {
    const { value, reused } = key && key.length > 0 ? await openShared(`gui:${key}`, make, isGuiAlive) : { value: await make(), reused: false };
    if (key) registerWindowSession(key, "gui", () => stopGui(value.sid, "window-closed"));
    return Response.json({ sid: value.sid, name: value.name, reused: reused || value.reused });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "启动失败";
    return Response.json({ error: msg }, { status: /过多/.test(msg) ? 429 : 400 });
  }
}
