import { publishChange } from "@/lib/change-events";
import { denyDesktop } from "@/lib/auth";
import { db } from "@/db";
import { desktopSettings, fsNodes } from "@/db/schema";
import {
  cleanName,
  ensureSeed,
  getAllNodes,
  getNode,
  resetAll,
  uniqueName,
} from "@/lib/fs-server";
import { eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

const changed = (body: object) => {
  publishChange("fs");
  return Response.json(body);
};

const MAX_CONTENT = 1_000_000;

export async function GET(req: Request) {
  const denied = await denyDesktop(req);
  if (denied) return denied;
  await ensureSeed();
  const nodes = await getAllNodes();
  const rows = await db.select().from(desktopSettings);
  const settings = Object.fromEntries(rows.filter((r) => r.key !== "wm_state").map((r) => [r.key, r.value]));
  return Response.json({ nodes, settings });
}

export async function POST(req: Request) {
  const denied = await denyDesktop(req);
  if (denied) return denied;
  const body = (await req.json().catch(() => null)) as {
    parentId?: number;
    name?: string;
    kind?: string;
    content?: string;
  } | null;
  if (!body) return Response.json({ error: "请求无效" }, { status: 400 });

  const name = cleanName(body.name);
  if (!name) return Response.json({ error: "名称无效" }, { status: 400 });
  if (body.kind !== "folder" && body.kind !== "file") {
    return Response.json({ error: "类型无效" }, { status: 400 });
  }
  if (typeof body.parentId !== "number") {
    return Response.json({ error: "不能在根目录创建" }, { status: 400 });
  }
  const parent = await getNode(body.parentId);
  if (!parent || parent.kind !== "folder") {
    return Response.json({ error: "目标文件夹不存在" }, { status: 404 });
  }
  const content = body.kind === "file" && typeof body.content === "string" ? body.content : "";
  if (content.length > MAX_CONTENT) {
    return Response.json({ error: "内容过大" }, { status: 413 });
  }

  const finalName = await uniqueName(parent.id, name);
  const [row] = await db
    .insert(fsNodes)
    .values({ parentId: parent.id, name: finalName, kind: body.kind, content })
    .returning();
  return changed({ node: row });
}

// ?trash=1 清空回收站； ?reset=1 重置整个系统
export async function DELETE(req: Request) {
  const denied = await denyDesktop(req);
  if (denied) return denied;
  const url = new URL(req.url);
  if (url.searchParams.get("reset") === "1") {
    await resetAll();
    return changed({ ok: true });
  }
  if (url.searchParams.get("trash") === "1") {
    const all = await getAllNodes();
    const trash = all.find((n) => n.parentId === null && n.name === "Trash");
    if (trash) await db.delete(fsNodes).where(eq(fsNodes.parentId, trash.id));
    return changed({ ok: true });
  }
  return Response.json({ error: "请求无效" }, { status: 400 });
}
