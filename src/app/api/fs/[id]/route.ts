import { publishChange } from "@/lib/change-events";
import { denyDesktop } from "@/lib/auth";
import { db } from "@/db";
import { fsNodes } from "@/db/schema";
import {
  ancestorsOf,
  cleanName,
  getAllNodes,
  getNode,
  uniqueName,
} from "@/lib/fs-server";
import { and, eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

const changed = (body: object) => {
  publishChange("fs");
  return Response.json(body);
};

const MAX_CONTENT = 1_000_000;

type Ctx = { params: Promise<{ id: string }> };

async function parseId(ctx: Ctx) {
  const { id } = await ctx.params;
  const n = Number(id);
  return Number.isInteger(n) ? n : null;
}

export async function PATCH(req: Request, ctx: Ctx) {
  const denied = await denyDesktop(req);
  if (denied) return denied;
  const id = await parseId(ctx);
  if (id === null) return Response.json({ error: "ID 无效" }, { status: 400 });
  const node = await getNode(id);
  if (!node) return Response.json({ error: "文件不存在" }, { status: 404 });

  const body = (await req.json().catch(() => null)) as {
    name?: string;
    content?: string;
    expectedContent?: string;
    parentId?: number;
    restore?: boolean;
  } | null;
  if (!body) return Response.json({ error: "请求无效" }, { status: 400 });

  const isSystem = node.parentId === null;
  const update: Partial<typeof fsNodes.$inferInsert> = { updatedAt: new Date() };
  let targetParent = node.parentId;

  if (body.restore) {
    if (isSystem) return Response.json({ error: "系统文件夹不可操作" }, { status: 403 });
    const all = await getAllNodes();
    const origin = all.find((n) => n.id === node.trashedFrom && n.kind === "folder");
    const fallback = all.find((n) => n.parentId === null && n.name === "Documents");
    targetParent = (origin ?? fallback)!.id;
    update.parentId = targetParent;
    update.trashedFrom = null;
  } else if (typeof body.parentId === "number" && body.parentId !== node.parentId) {
    if (isSystem) return Response.json({ error: "系统文件夹不可移动" }, { status: 403 });
    const dest = await getNode(body.parentId);
    if (!dest || dest.kind !== "folder") {
      return Response.json({ error: "目标文件夹不存在" }, { status: 404 });
    }
    const all = await getAllNodes();
    if (dest.id === node.id || ancestorsOf(all, dest.id).includes(node.id)) {
      return Response.json({ error: "不能把文件夹移动到它自己里面" }, { status: 400 });
    }
    targetParent = dest.id;
    update.parentId = dest.id;
    update.trashedFrom = null;
  }

  if (body.name !== undefined) {
    if (isSystem) return Response.json({ error: "系统文件夹不可重命名" }, { status: 403 });
    const name = cleanName(body.name);
    if (!name) return Response.json({ error: "名称无效" }, { status: 400 });
    update.name = await uniqueName(targetParent, name, node.id);
  } else if (update.parentId !== undefined) {
    update.name = await uniqueName(targetParent, node.name, node.id);
  }

  if (body.content !== undefined) {
    if (node.kind !== "file") return Response.json({ error: "文件夹没有内容" }, { status: 400 });
    if (typeof body.content !== "string" || body.content.length > MAX_CONTENT) {
      return Response.json({ error: "内容无效或过大" }, { status: 413 });
    }
    update.content = body.content;
  }

  const condition = typeof body.expectedContent === "string" && body.content !== undefined
    ? and(eq(fsNodes.id, id), eq(fsNodes.content, body.expectedContent))
    : eq(fsNodes.id, id);
  const [row] = await db.update(fsNodes).set(update).where(condition).returning();
  if (!row) return Response.json({ error: "文件已在其他界面修改，请重新加载后再保存。未保存的内容仍保留在编辑器中。" }, { status: 409 });
  return changed({ node: row });
}

// 默认移入回收站；?permanent=1 或已在回收站中则彻底删除
export async function DELETE(req: Request, ctx: Ctx) {
  const denied = await denyDesktop(req);
  if (denied) return denied;
  const id = await parseId(ctx);
  if (id === null) return Response.json({ error: "ID 无效" }, { status: 400 });
  const node = await getNode(id);
  if (!node) return Response.json({ error: "文件不存在" }, { status: 404 });
  if (node.parentId === null) {
    return Response.json({ error: "系统文件夹不可删除" }, { status: 403 });
  }

  const all = await getAllNodes();
  const trash = all.find((n) => n.parentId === null && n.name === "Trash")!;
  const permanent = new URL(req.url).searchParams.get("permanent") === "1";
  const inTrash = ancestorsOf(all, id).includes(trash.id);

  if (permanent || inTrash) {
    await db.delete(fsNodes).where(eq(fsNodes.id, id));
    return changed({ deleted: true });
  }

  const name = await uniqueName(trash.id, node.name);
  const [row] = await db
    .update(fsNodes)
    .set({ parentId: trash.id, trashedFrom: node.parentId, name, updatedAt: new Date() })
    .where(eq(fsNodes.id, id))
    .returning();
  return changed({ node: row });
}
