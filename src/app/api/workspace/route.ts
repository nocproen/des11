import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { desktopWorkspace } from "@/db/schema";
import { denyDesktop } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const headers = { "Cache-Control": "private, no-store" };
const DEFAULT = { wins: [], z: 10, seq: 0 };
const APPS = new Set([
  "lite", "gui", "browser", "sysfiles", "systerm", "monitor", "sysedit",
  "files", "notepad", "terminal", "settings", "calculator",
]);

function parseSnapshot(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const raw = input as Record<string, unknown>;
  if (!Array.isArray(raw.wins) || raw.wins.length > 30) return null;
  const num = (v: unknown, min: number, max: number, fallback: number) =>
    typeof v === "number" && Number.isFinite(v) ? Math.max(min, Math.min(max, Math.round(v))) : fallback;
  const wins = raw.wins.map((v: unknown) => {
    if (!v || typeof v !== "object" || Array.isArray(v)) return null;
    const w = v as Record<string, unknown>;
    if (typeof w.id !== "string" || !/^w\d{1,10}$/.test(w.id) || !APPS.has(String(w.app))) return null;
    const out: Record<string, unknown> = {
      id: w.id, app: w.app,
      x: num(w.x, -5000, 5000, 80), y: num(w.y, 0, 5000, 40),
      w: num(w.w, 180, 4000, 800), h: num(w.h, 130, 4000, 540),
      z: num(w.z, 0, 100000, 10),
      minimized: w.minimized === true, maximized: w.maximized === true,
    };
    for (const key of ["path", "title", "cmd", "desktopFile", "iconUrl"]) {
      if (typeof w[key] === "string") out[key] = (w[key] as string).slice(0, 2048);
    }
    for (const key of ["folderId", "fileId"]) {
      if (w[key] === null && key === "folderId") out[key] = null;
      else if (typeof w[key] === "number" && Number.isSafeInteger(w[key])) out[key] = w[key];
    }
    if (typeof w.guiSid === "string" && w.guiSid.length <= 128) out.guiSid = w.guiSid;
    if (typeof w.browserActiveIndex === "number") out.browserActiveIndex = num(w.browserActiveIndex, 0, 9, 0);
    if (Array.isArray(w.browserTabs)) {
      out.browserTabs = w.browserTabs
        .filter((u: unknown): u is string => typeof u === "string" && u.length <= 2048 && (u === "about:blank" || /^https?:\/\//i.test(u)))
        .slice(0, 10);
    }
    return out;
  }).filter((win): win is Record<string, unknown> => win !== null);
  return {
    wins,
    z: num(raw.z, 10, 100000, 10),
    seq: num(raw.seq, 0, 100000, 0),
  };
}

async function getCurrent() {
  const [row] = await db.select().from(desktopWorkspace).where(eq(desktopWorkspace.id, 1));
  return row ?? null;
}

export async function GET(req: Request) {
  const denied = await denyDesktop(req);
  if (denied) return denied;
  const row = await getCurrent();
  return Response.json({
    snapshot: row?.snapshot ?? DEFAULT,
    version: row?.version ?? 0,
    updatedAt: row?.updatedAt ?? null,
  }, { headers });
}

export async function PUT(req: Request) {
  const denied = await denyDesktop(req);
  if (denied) return denied;
  if (Number(req.headers.get("content-length") || "0") > 150_000) {
    return Response.json({ error: "桌面快照过大" }, { status: 413, headers });
  }
  const body = (await req.json().catch(() => null)) as { snapshot?: unknown; version?: unknown; force?: unknown } | null;
  const snapshot = parseSnapshot(body?.snapshot);
  const version = body?.version;
  if (!snapshot || typeof version !== "number" || !Number.isSafeInteger(version) || version < 0) {
    return Response.json({ error: "桌面快照格式无效" }, { status: 400, headers });
  }

  // 关页时 keepalive 写入：避免先前尚在途中的防抖请求使最终屏幕快照丢失。
  if (body?.force === true) {
    const [updated] = await db.update(desktopWorkspace)
      .set({ snapshot, version: sql`${desktopWorkspace.version} + 1`, updatedAt: new Date() })
      .where(eq(desktopWorkspace.id, 1)).returning();
    if (updated) return Response.json({ ok: true, version: updated.version }, { headers });
    const [inserted] = await db.insert(desktopWorkspace).values({ id: 1, snapshot, version: 1 })
      .onConflictDoUpdate({ target: desktopWorkspace.id, set: { snapshot, version: sql`${desktopWorkspace.version} + 1`, updatedAt: new Date() } })
      .returning();
    return Response.json({ ok: true, version: inserted.version }, { headers });
  }

  if (version === 0) {
    const [inserted] = await db.insert(desktopWorkspace)
      .values({ id: 1, snapshot, version: 1 })
      .onConflictDoNothing()
      .returning();
    if (inserted) return Response.json({ ok: true, version: inserted.version }, { headers });
  } else {
    const [updated] = await db.update(desktopWorkspace)
      .set({ snapshot, version: sql`${desktopWorkspace.version} + 1`, updatedAt: new Date() })
      .where(and(eq(desktopWorkspace.id, 1), eq(desktopWorkspace.version, version)))
      .returning();
    if (updated) return Response.json({ ok: true, version: updated.version }, { headers });
  }

  const current = await getCurrent();
  return Response.json({ error: "桌面已被新会话更新，请重新加载", version: current?.version ?? 0, snapshot: current?.snapshot ?? DEFAULT }, { status: 409, headers });
}
