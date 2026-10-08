import { denyDesktop } from "@/lib/auth";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SIGNALS = new Set(["SIGTERM", "SIGKILL", "SIGINT", "SIGHUP", "SIGSTOP", "SIGCONT"]);

export async function POST(req: Request) {
  const denied = await denyDesktop(req);
  if (denied) return denied;
  const b = (await req.json().catch(() => null)) as { pid?: number; signal?: string } | null;
  if (!b || !Number.isInteger(b.pid) || !b.signal || !SIGNALS.has(b.signal)) {
    return Response.json({ error: "参数无效" }, { status: 400 });
  }
  const pid = b.pid as number;
  if (pid <= 1) return Response.json({ error: "不能终止 init 进程" }, { status: 403 });
  if (pid === process.pid || pid === process.ppid) {
    return Response.json({ error: "不能终止正在运行本网站的进程" }, { status: 403 });
  }
  try {
    process.kill(pid, b.signal as NodeJS.Signals);
    return Response.json({ ok: true });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return Response.json({ error: "进程不存在" }, { status: 404 });
    if (code === "EPERM") return Response.json({ error: "权限不足" }, { status: 403 });
    return Response.json({ error: "操作失败" }, { status: 500 });
  }
}
