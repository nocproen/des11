import { closeWindowSessions } from "./session-lifecycle";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { desktopSettings } from "@/db/schema";
import { mergeDesktop, type SharedState, type SharedWin } from "./desktop-state";
export type { SharedState, SharedWin } from "./desktop-state";

export type SyncEvent = { version: number; state: SharedState; origin: string };
type Store = { version: number; state: SharedState; listeners: Set<(ev: SyncEvent) => void> };
const holder = globalThis as unknown as {
  __wdDesktopSyncV2?: Store;
  __wdSharedKeys?: Map<string, Promise<unknown>>;
};
const S: Store = (holder.__wdDesktopSyncV2 ??= {
  version: 0, state: { wins: [], z: 10, seq: 0 }, listeners: new Set(),
});
const KEYS = (holder.__wdSharedKeys ??= new Map());
const SETTING_KEY = "wm_state";
const APPS = new Set(["lite", "gui", "browser", "sysfiles", "systerm", "monitor", "sysedit", "files", "notepad", "terminal", "settings", "calculator"]);
const NUMBERS = new Set(["x", "y", "w", "h", "z", "folderId", "fileId"]);
const FLAGS = new Set(["minimized", "maximized"]);
const STRINGS = new Set(["path", "title", "cmd", "desktopFile", "iconUrl"]);

function cleanWin(raw: unknown): SharedWin | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== "string" || !/^[\w-]{1,64}$/.test(o.id) || typeof o.app !== "string" || !APPS.has(o.app)) return null;
  const out: SharedWin = { id: o.id, app: o.app };
  for (const [key, value] of Object.entries(o)) {
    if (NUMBERS.has(key) && typeof value === "number" && Number.isFinite(value)) out[key] = Math.max(-100_000, Math.min(10_000_000, value));
    else if (FLAGS.has(key) && typeof value === "boolean") out[key] = value;
    else if (STRINGS.has(key) && typeof value === "string" && value.length <= 4000) out[key] = value;
    else if (key === "folderId" && value === null) out[key] = null;
  }
  return out;
}

export function sanitize(raw: unknown): SharedState | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { wins?: unknown; z?: unknown; seq?: unknown };
  if (!Array.isArray(r.wins) || r.wins.length > 64) return null;
  const wins: SharedWin[] = [];
  const seen = new Set<string>();
  for (const w of r.wins) {
    const cleaned = cleanWin(w);
    if (!cleaned || seen.has(cleaned.id)) return null;
    wins.push(cleaned);
    seen.add(cleaned.id);
  }
  const num = (v: unknown, fallback: number) => typeof v === "number" && Number.isFinite(v) ? Math.max(0, v) : fallback;
  return { wins, z: num(r.z, 10), seq: num(r.seq, 0) };
}

function decode(value?: string) {
  if (!value) return { state: { wins: [], z: 10, seq: 0 } as SharedState, version: 0 };
  const raw = JSON.parse(value) as Record<string, unknown>;
  const state = sanitize(raw);
  if (!state) throw new Error("Invalid stored desktop state");
  return { state, version: typeof raw._version === "number" ? raw._version : 0 };
}

export async function getShared() {
  const [row] = await db.select().from(desktopSettings).where(eq(desktopSettings.key, SETTING_KEY));
  const stored = decode(row?.value);
  const changed = JSON.stringify(stored.state) !== JSON.stringify(S.state);
  const version = changed ? Math.max(stored.version, S.version + 1, Date.now()) : Math.max(stored.version, S.version);
  S.state = stored.state;
  S.version = version;
  return { version, state: S.state };
}

// An advisory transaction lock makes read/merge/write atomic across requests and
// workers. Successful responses are already durable, not waiting on a debounce.
export async function commit(raw: unknown, origin: string, rawBase?: unknown) {
  const incoming = sanitize(raw);
  const base = rawBase === undefined ? undefined : sanitize(rawBase);
  if (!incoming || base === null) return null;
  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(424243)`);
    const [row] = await tx.select().from(desktopSettings).where(eq(desktopSettings.key, SETTING_KEY));
    const stored = decode(row?.value);
    const state = base ? mergeDesktop(stored.state, incoming, base) : incoming;
    const version = Math.max(stored.version + 1, S.version + 1, Date.now());
    const value = JSON.stringify({ ...state, _version: version });
    await tx.insert(desktopSettings).values({ key: SETTING_KEY, value })
      .onConflictDoUpdate({ target: desktopSettings.key, set: { value } });
    return { version, state, removed: stored.state.wins.filter((w) => !state.wins.some((next) => next.id === w.id)).map((w) => w.id) };
  });
  closeWindowSessions(result.removed);
  if (result.version >= S.version) { S.state = result.state; S.version = result.version; }
  for (const listener of S.listeners) {
    try { listener({ ...result, origin }); } catch { /* disconnected subscriber */ }
  }
  return result;
}

export function subscribe(fn: (ev: SyncEvent) => void) {
  S.listeners.add(fn);
  return () => { S.listeners.delete(fn); };
}

// Keep creation itself inside the shared promise, including after an expired
// session: two browsers reconnecting simultaneously must not create duplicates.
export async function openShared<T extends { sid: string }>(key: string, make: () => Promise<T>, alive: (sid: string) => boolean): Promise<{ value: T; reused: boolean }> {
  const prev = KEYS.get(key) as Promise<T> | undefined;
  if (prev) {
    const value = await prev.catch(() => null);
    if (value && alive(value.sid)) return { value, reused: true };
    if (KEYS.get(key) !== prev) return openShared(key, make, alive);
  }
  const pending = Promise.resolve().then(make);
  KEYS.set(key, pending);
  try {
    return { value: await pending, reused: false };
  } catch (error) {
    if (KEYS.get(key) === pending) KEYS.delete(key);
    throw error;
  }
}
