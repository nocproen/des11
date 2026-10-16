import { denyDesktop } from "@/lib/auth";
import {
  getGui,
  setClipboardFilesForSession,
  setClipboardUploadedFile,
  triggerVncPaste,
} from "@/lib/gui";
import { fsError, resolveP } from "@/lib/sys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_FILE = 64 * 1024 * 1024;

type Ctx = { params: Promise<{ sid: string }> };

// 把模拟桌面上的文件/图片、或者本机剪贴板里的文件/图片放进远程 VNC 应用的剪贴板（可选直接触发粘贴）
export async function POST(req: Request, ctx: Ctx) {
  const denied = await denyDesktop(req);
  if (denied) return denied;
  const { sid } = await ctx.params;
  const g = getGui(sid);
  if (!g) return Response.json({ error: "会话不存在或已结束" }, { status: 404 });

  const url = new URL(req.url);
  const ct = (req.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();

  if (ct === "application/json") {
    const b = (await req.json().catch(() => null)) as {
      paths?: unknown;
      cut?: unknown;
      triggerPaste?: unknown;
      x?: unknown;
      y?: unknown;
    } | null;
    if (!b) return Response.json({ error: "参数无效" }, { status: 400 });
    try {
      const rawPaths = Array.isArray(b.paths)
        ? b.paths.filter((p): p is string => typeof p === "string" && p.trim().length > 0)
        : [];
      if (rawPaths.length > 0) {
        const resolved = rawPaths.map((p) => resolveP(p));
        const clip = await setClipboardFilesForSession(g, resolved, !!b.cut, !!b.triggerPaste);
        return Response.json({ ok: true, clip });
      }
      if (b.triggerPaste) {
        await triggerVncPaste(g, Number(b.x), Number(b.y));
        return Response.json({ ok: true });
      }
      return Response.json({ error: "未提供要复制的文件" }, { status: 400 });
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code) return fsError(e);
      return Response.json({ error: e instanceof Error ? e.message : "操作失败" }, { status: 400 });
    }
  }

  const data = Buffer.from(await req.arrayBuffer());
  if (!data.length || data.length > MAX_FILE) {
    return Response.json({ error: "文件为空或超过 64MB" }, { status: 400 });
  }
  const filename = url.searchParams.get("name") ?? undefined;
  const triggerPaste = url.searchParams.get("paste") === "1";
  const x = url.searchParams.has("x") ? Number(url.searchParams.get("x")) : undefined;
  const y = url.searchParams.has("y") ? Number(url.searchParams.get("y")) : undefined;

  try {
    const clip = await setClipboardUploadedFile(
      g,
      data,
      ct || "application/octet-stream",
      filename,
      triggerPaste,
      x,
      y,
    );
    return Response.json({ ok: true, clip });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "操作失败" }, { status: 400 });
  }
}
