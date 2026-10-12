import { db } from "@/db";
import { desktopSettings, fsNodes } from "@/db/schema";
import { asc, eq, sql } from "drizzle-orm";

export type NodeRow = typeof fsNodes.$inferSelect;

export const SYSTEM_FOLDERS = ["Desktop", "Documents", "Downloads", "Pictures", "Trash"];

const WELCOME = `欢迎使用 WebDesktop！

这是一个运行在浏览器里的模拟桌面系统：
  • 双击桌面图标或文件打开
  • 右键桌面 / 文件可以打开快捷菜单
  • 拖动标题栏移动窗口，拖动边缘缩放窗口
  • 文件拖到文件夹上即可移动
  • 所有文件都保存在服务器数据库中，刷新页面也不会丢失

试试打开「终端」，输入 help 查看可用命令。
`;

const TERMINAL_TIPS = `终端常用命令
-------------
ls            列出文件
cd Documents  进入目录
cat 文件      查看内容
mkdir 目录    新建文件夹
touch 文件    新建文件
echo hi > a.txt  写入文件
rm 文件       移到回收站
open 文件     用图形界面打开
neofetch      系统信息
`;

export async function ensureSeed() {
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(424242)`);
    const [{ count }] = await tx.select({ count: sql<number>`count(*)::int` }).from(fsNodes);
    if (count > 0) return;

    const roots = await tx
      .insert(fsNodes)
      .values(SYSTEM_FOLDERS.map((name) => ({ name, kind: "folder", parentId: null })))
      .returning();
    const byName = (n: string) => roots.find((r) => r.name === n)!.id;

    await tx.insert(fsNodes).values([
      { name: "欢迎.txt", kind: "file", parentId: byName("Desktop"), content: WELCOME },
      { name: "终端指南.txt", kind: "file", parentId: byName("Desktop"), content: TERMINAL_TIPS },
      {
        name: "待办清单.md",
        kind: "file",
        parentId: byName("Documents"),
        content: "# 待办清单\n\n- [x] 启动桌面系统\n- [ ] 创建我的第一个文件夹\n- [ ] 换一张喜欢的壁纸\n",
      },
      {
        name: "项目",
        kind: "folder",
        parentId: byName("Documents"),
        content: "",
      },
      {
        name: "readme.txt",
        kind: "file",
        parentId: byName("Downloads"),
        content: "下载文件夹。\n",
      },
    ]);
  });
}

export async function resetAll() {
  await db.delete(fsNodes);
  await db.delete(desktopSettings);
  await ensureSeed();
}

export async function getAllNodes() {
  return db.select().from(fsNodes).orderBy(asc(fsNodes.id));
}

export async function getNode(id: number) {
  const [row] = await db.select().from(fsNodes).where(eq(fsNodes.id, id));
  return row as NodeRow | undefined;
}

export function cleanName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.trim();
  if (!name || name.length > 120 || /[\/\\]/.test(name) || name === "." || name === "..") {
    return null;
  }
  return name;
}

// 同一目录下重名时自动追加 (2)、(3)……
export async function uniqueName(parentId: number | null, name: string, excludeId?: number) {
  const all = await getAllNodes();
  const taken = new Set(
    all
      .filter((n) => n.parentId === parentId && n.id !== excludeId)
      .map((n) => n.name.toLowerCase()),
  );
  if (!taken.has(name.toLowerCase())) return name;
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base} (${i})${ext}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return `${base}-${Date.now()}${ext}`;
}

export function ancestorsOf(all: NodeRow[], id: number): number[] {
  const map = new Map(all.map((n) => [n.id, n]));
  const out: number[] = [];
  let cur = map.get(id);
  while (cur && cur.parentId !== null) {
    out.push(cur.parentId);
    cur = map.get(cur.parentId);
  }
  return out;
}
