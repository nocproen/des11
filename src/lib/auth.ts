import crypto from "crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { adminUsers, authConfig } from "@/db/schema";

// 两套完全独立的登录：
//  - 桌面：一个访问密码（由后台设置），Cookie = wd_session
//  - 后台：独立的管理员账号 + 密码，Cookie = wd_admin
// 会话是带 HMAC 签名的令牌，签名密钥保存在数据库里；改密码 / 强制下线会让旧令牌立即失效。

export const DESKTOP_COOKIE = "wd_session";
export const ADMIN_COOKIE = "wd_admin";
// 后台路径：默认值不常见，可用环境变量 ADMIN_PATH 自定义
export const ADMIN_SLUG = (process.env.ADMIN_PATH || "ops-7k2m9x4q").replace(/^\/+|\/+$/g, "");
// 桌面会话时长：30 天。若后台设置了密码到期时间，则以到期时间为准（30天与密码到期取较早者）
export const DESKTOP_MAX_AGE = 7 * 24 * 3600;
export const DESKTOP_SHORT_AGE = 30 * 24 * 3600;
export const ADMIN_MAX_AGE = 12 * 3600;

export const DEFAULT_ADMIN_USER = process.env.ADMIN_USER || "admin";
const INITIAL_ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "Admin@Des11#2026";

type Try = { n: number; first: number; lock: number };
type State = {
  ready?: Promise<void>;
  secret?: string;
  cache: Map<string, { v: string | null; t: number }>;
  tries: Map<string, Try>;
};
const holder = globalThis as unknown as { __wdAuth?: State };
const S: State = (holder.__wdAuth ??= { cache: new Map(), tries: new Map() });

/* ---------------- 密码哈希 (scrypt) ---------------- */

function scrypt(pw: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    crypto.scrypt(pw, salt, 64, { N: 16384, r: 8, p: 1 }, (e, k) => (e ? reject(e) : resolve(k))),
  );
}

export async function hashPassword(pw: string) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw, salt);
  return `s1$${salt.toString("hex")}$${key.toString("hex")}`;
}

const DUMMY_HASH = "s1$00000000000000000000000000000000$" + "00".repeat(64);

export async function verifyPassword(pw: string, stored: string | null | undefined) {
  const parts = (stored ?? DUMMY_HASH).split("$");
  if (parts.length !== 3 || parts[0] !== "s1") return false;
  const key = await scrypt(pw, Buffer.from(parts[1], "hex"));
  const want = Buffer.from(parts[2], "hex");
  return want.length === key.length && crypto.timingSafeEqual(want, key) && stored != null;
}

/* ---------------- 数据库：建表 / 配置 ---------------- */

export function ensureAuthTables() {
  S.ready ??= (async () => {
    await db.execute(sql`create table if not exists auth_config (key text primary key, value text not null)`);
    await db.execute(sql`create table if not exists admin_users (
      id serial primary key,
      username text not null,
      password_hash text not null,
      must_change boolean not null default false,
      created_at timestamptz not null default now(),
      constraint admin_users_username_unique unique (username)
    )`);
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(adminUsers);
    if (n === 0) {
      // 全新部署必须显式提供初始密码，不使用公开可猜的默认凭据。
      if (!INITIAL_ADMIN_PASSWORD) throw new Error("首次部署前请设置 ADMIN_PASSWORD 环境变量");
      await db
        .insert(adminUsers)
        .values({
          username: DEFAULT_ADMIN_USER,
          passwordHash: await hashPassword(INITIAL_ADMIN_PASSWORD),
          mustChange: false,
        })
        .onConflictDoNothing();
    }
  })().catch((e) => {
    S.ready = undefined;
    throw e;
  });
  return S.ready;
}

async function getCfg(key: string, ttl = 2000): Promise<string | null> {
  const hit = S.cache.get(key);
  if (hit && Date.now() - hit.t < ttl) return hit.v;
  await ensureAuthTables();
  const [row] = await db.select().from(authConfig).where(eq(authConfig.key, key));
  const v = row?.value ?? null;
  S.cache.set(key, { v, t: Date.now() });
  return v;
}

async function setCfg(key: string, value: string) {
  await ensureAuthTables();
  await db
    .insert(authConfig)
    .values({ key, value })
    .onConflictDoUpdate({ target: authConfig.key, set: { value } });
  S.cache.delete(key);
}

async function delCfg(key: string) {
  await ensureAuthTables();
  await db.delete(authConfig).where(eq(authConfig.key, key));
  S.cache.delete(key);
}

async function getSecret() {
  if (S.secret) return S.secret;
  await ensureAuthTables();
  let v = await getCfg("secret", 0);
  if (!v) {
    await db
      .insert(authConfig)
      .values({ key: "secret", value: crypto.randomBytes(32).toString("hex") })
      .onConflictDoNothing();
    S.cache.delete("secret");
    v = await getCfg("secret", 0);
  }
  S.secret = v!;
  return S.secret;
}

/* ---------------- 令牌 ---------------- */

async function sign(payload: object) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const mac = crypto.createHmac("sha256", await getSecret()).update(body).digest("base64url");
  return `${body}.${mac}`;
}

async function unsign<T extends { exp: number }>(token?: string | null): Promise<T | null> {
  if (!token || token.length > 2000) return null;
  const i = token.indexOf(".");
  if (i < 1) return null;
  const body = token.slice(0, i);
  const mac = Buffer.from(token.slice(i + 1));
  const want = Buffer.from(crypto.createHmac("sha256", await getSecret()).update(body).digest("base64url"));
  if (mac.length !== want.length || !crypto.timingSafeEqual(mac, want)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString()) as T;
    return p.exp > Date.now() ? p : null;
  } catch {
    return null;
  }
}

export function cookieValue(header: string | null | undefined, name: string) {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

export function isHttps(req: Request) {
  const xf = req.headers.get("x-forwarded-proto")?.split(",")[0].trim();
  if (xf) return xf === "https";
  try {
    return new URL(req.url).protocol === "https:";
  } catch {
    return false;
  }
}

export function setCookieHeader(name: string, value: string, req: Request, maxAge?: number) {
  return (
    `${name}=${value}; Path=/; HttpOnly; SameSite=Lax` +
    (maxAge !== undefined ? `; Max-Age=${maxAge}` : "") +
    (isHttps(req) ? "; Secure" : "")
  );
}

export const clearCookieHeader = (name: string, req: Request) => setCookieHeader(name, "", req, 0);

/* ---------------- 桌面密码 / 会话 ---------------- */

export async function isDesktopPasswordSet() {
  return !!(await getCfg("desk_hash"));
}

/* 当前密码以 AES-256-GCM 加密后保存，供后台查看（密钥由服务端签名密钥派生，可用环境变量 AUTH_KEY 额外加固） */
async function encKey() {
  return crypto.createHash("sha256").update(`${await getSecret()}|${process.env.AUTH_KEY ?? ""}`).digest();
}

async function encryptText(plain: string) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", await encKey(), iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return `e1$${iv.toString("base64url")}$${c.getAuthTag().toString("base64url")}$${ct.toString("base64url")}`;
}

async function decryptText(stored: string | null): Promise<string | null> {
  const p = stored?.split("$");
  if (!p || p.length !== 4 || p[0] !== "e1") return null;
  try {
    const d = crypto.createDecipheriv("aes-256-gcm", await encKey(), Buffer.from(p[1], "base64url"));
    d.setAuthTag(Buffer.from(p[2], "base64url"));
    return Buffer.concat([d.update(Buffer.from(p[3], "base64url")), d.final()]).toString("utf8");
  } catch {
    return null;
  }
}

export type DesktopStatus = { set: boolean; setAt: number | null; expiresAt: number | null; expired: boolean };

/** 桌面密码状态：是否已设置、设置时间、到期时间、是否已过期 */
export async function getDesktopStatus(): Promise<DesktopStatus> {
  const set = !!(await getCfg("desk_hash"));
  const exp = Number((await getCfg("desk_expires")) ?? 0) || null;
  const setAt = Number((await getCfg("desk_set_at")) ?? 0) || null;
  return { set, setAt, expiresAt: exp, expired: set && !!exp && exp <= Date.now() };
}

export async function getDesktopPlain() {
  return decryptText(await getCfg("desk_plain", 0));
}

/** expiresAt = 到期时间戳(毫秒)，null = 永久有效 */
export async function setDesktopPassword(pw: string, expiresAt: number | null) {
  await setCfg("desk_hash", await hashPassword(pw));
  await setCfg("desk_plain", await encryptText(pw));
  await setCfg("desk_set_at", String(Date.now()));
  if (expiresAt) await setCfg("desk_expires", String(expiresAt));
  else await delCfg("desk_expires");
  await bumpDesktopVersion(); // 换密码 = 所有旧会话下线
}

/**
 * 桌面用户改密码：只更新密码相关字段，绝不修改 desk_expires。
 * 事务内重新验证旧密码与到期状态，避免两个改密请求并发时使用过期的旧密码。
 */
export async function changeDesktopPasswordKeepingExpiry(current: string, next: string): Promise<"ok" | "invalid" | "expired" | "unset"> {
  await ensureAuthTables();
  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(28411, 1)`);
    const rows = await tx.select().from(authConfig).where(inArray(authConfig.key, ["desk_hash", "desk_expires", "desk_ver"]));
    const config = new Map(rows.map((row) => [row.key, row.value]));
    const stored = config.get("desk_hash");
    if (!stored) return "unset" as const;
    const expiresAt = Number(config.get("desk_expires") ?? 0);
    if (expiresAt && expiresAt <= Date.now()) return "expired" as const;
    if (!(await verifyPassword(current, stored))) return "invalid" as const;

    const hash = await hashPassword(next);
    const encrypted = await encryptText(next);
    const version = Number(config.get("desk_ver") ?? "1");
    const values = [
      { key: "desk_hash", value: hash },
      { key: "desk_plain", value: encrypted },
      { key: "desk_set_at", value: String(Date.now()) },
      { key: "desk_ver", value: String(Number.isFinite(version) ? version + 1 : 2) },
    ];
    for (const entry of values) {
      await tx.insert(authConfig).values(entry).onConflictDoUpdate({ target: authConfig.key, set: { value: entry.value } });
    }
    return "ok" as const;
  });
  if (result === "ok") {
    for (const key of ["desk_hash", "desk_plain", "desk_set_at", "desk_ver"]) S.cache.delete(key);
  }
  return result;
}

/** 只修改有效期，密码不变。如果密码已过期，旧会话仍然保持失效 */
export async function setDesktopExpiry(expiresAt: number | null) {
  const before = await getDesktopStatus();
  if (expiresAt) await setCfg("desk_expires", String(expiresAt));
  else await delCfg("desk_expires");
  if (before.expired) await bumpDesktopVersion();
}

export async function clearDesktopPassword() {
  for (const k of ["desk_hash", "desk_plain", "desk_set_at", "desk_expires"]) await delCfg(k);
  await bumpDesktopVersion();
}

export async function bumpDesktopVersion() {
  const cur = Number((await getCfg("desk_ver", 0)) ?? "1");
  await setCfg("desk_ver", String(cur + 1));
}

export async function checkDesktopPassword(pw: string) {
  return verifyPassword(pw, await getCfg("desk_hash", 0));
}

// 每次成功登录生成新的随机会话。活跃会话记录在 PostgreSQL 中，不依赖单个 Node 进程的内存。
// 同一个浏览器的不同标签共享 Cookie，因此还要求每页自己的随机会话标识。
export async function createDesktopToken(password: string) {
  await ensureAuthTables();
  const sessionId = crypto.randomBytes(24).toString("base64url");
  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(28411, 1)`);
    const rows = await tx.select().from(authConfig).where(inArray(authConfig.key, ["desk_hash", "desk_ver", "desk_expires"]));
    const config = new Map(rows.map((row) => [row.key, row.value]));
    if (!(await verifyPassword(password, config.get("desk_hash")))) return null;
    const passwordExpiry = Number(config.get("desk_expires") ?? 0);
    if (passwordExpiry && passwordExpiry <= Date.now()) return null;
    // 修复：之前 token 只有 12 小时，无论是否有人登录都会过期被踢。
    // 现在：若密码设置了到期时间，token 到期 = min(30天后, 密码到期)；若永久有效，则 token 30天有效。
    // 保证：空闲时不会被踢，只有新登录（desk_active 改变）或改密码/到期才会踢。
    const longExpiry = Date.now() + DESKTOP_SHORT_AGE * 1000;
    const expiry = passwordExpiry ? Math.min(longExpiry, passwordExpiry) : longExpiry;
    await tx.insert(authConfig).values({ key: "desk_active", value: sessionId })
      .onConflictDoUpdate({ target: authConfig.key, set: { value: sessionId } });
    return { version: config.get("desk_ver") ?? "1", expiry };
  });
  S.cache.delete("desk_active");
  if (!result) return null;
  return {
    token: await sign({ k: "d", exp: result.expiry, v: result.version, sid: sessionId }),
    sessionId,
  };
}

export async function verifyDesktopToken(token?: string | null, sessionId?: string | null) {
  if (!sessionId || sessionId.length > 128) return false;
  const p = await unsign<{ k: string; exp: number; v: string; sid?: string }>(token);
  if (!p || p.k !== "d" || p.sid !== sessionId) return false;
  const st = await getDesktopStatus();
  if (!st.set || st.expired) return false;
  return p.v === ((await getCfg("desk_ver", 0)) ?? "1") && p.sid === (await getCfg("desk_active", 0));
}

function requestDesktopSession(req: Request) {
  // 图片、音频、视频及下载链接无法添加自定义请求头，使用同源 URL 查询参数。
  return req.headers.get("x-desktop-session") ?? new URL(req.url).searchParams.get("access");
}

/** API 路由守卫：Cookie + 此页面独有的会话标识必须同时匹配。 */
export async function denyDesktop(req: Request): Promise<Response | null> {
  try {
    if (await verifyDesktopToken(cookieValue(req.headers.get("cookie"), DESKTOP_COOKIE), requestDesktopSession(req))) return null;
  } catch {
    return Response.json({ error: "服务暂时不可用，请稍后重试" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  return Response.json({ error: "其他设备已登录或登录已过期，请重新输入密码" }, { status: 401, headers: { "Cache-Control": "no-store" } });
}

/** WebSocket 升级请求及定期续验均同时检查 Cookie 与原页面会话标识。 */
export async function desktopAuthedHeader(cookieHeader: string | undefined, sessionId: string | null) {
  try {
    return await verifyDesktopToken(cookieValue(cookieHeader, DESKTOP_COOKIE), sessionId);
  } catch {
    return false;
  }
}

/** 与上面相同，但数据库暂时故障时不误杀仍在运行的进程。 */
export async function desktopAuthState(cookieHeader: string | undefined, sessionId: string | null): Promise<boolean | null> {
  try {
    return await verifyDesktopToken(cookieValue(cookieHeader, DESKTOP_COOKIE), sessionId);
  } catch {
    return null;
  }
}

/* ---------------- 后台管理员 ---------------- */

export type AdminUser = typeof adminUsers.$inferSelect;

const fp = (hash: string) => crypto.createHash("sha256").update(hash).digest("hex").slice(0, 16);

export async function findAdminByName(name: string) {
  await ensureAuthTables();
  const [u] = await db.select().from(adminUsers).where(eq(adminUsers.username, name));
  return u as AdminUser | undefined;
}

export async function createAdminToken(u: AdminUser) {
  const sessionId = crypto.randomBytes(24).toString("base64url");
  const key = `admin_active_${u.id}`;
  await setCfg(key, sessionId);
  return {
    token: await sign({ k: "a", exp: Date.now() + ADMIN_MAX_AGE * 1000, uid: u.id, fp: fp(u.passwordHash), sid: sessionId }),
    sessionId,
  };
}

export async function verifyAdminToken(token?: string | null, sessionId?: string | null): Promise<AdminUser | null> {
  if (sessionId && sessionId.length > 128) return null;
  const p = await unsign<{ k: string; exp: number; uid: number; fp: string; sid?: string }>(token);
  if (!p || p.k !== "a") return null;
  const sid = sessionId || p.sid;
  if (!sid || p.sid !== sid) return null;
  await ensureAuthTables();
  const [u] = await db.select().from(adminUsers).where(eq(adminUsers.id, p.uid));
  if (!u || fp(u.passwordHash) !== p.fp) return null;
  return (await getCfg(`admin_active_${u.id}`, 0)) === sid ? u : null;
}

export async function requireAdmin(req: Request) {
  try {
    return await verifyAdminToken(cookieValue(req.headers.get("cookie"), ADMIN_COOKIE), req.headers.get("x-admin-session"));
  } catch {
    return null;
  }
}

export async function updateAdmin(id: number, patch: { username?: string; password?: string }) {
  const set: Partial<typeof adminUsers.$inferInsert> = {};
  if (patch.username) set.username = patch.username;
  if (patch.password) {
    set.passwordHash = await hashPassword(patch.password);
    set.mustChange = false;
  }
  const [u] = await db.update(adminUsers).set(set).where(eq(adminUsers.id, id)).returning();
  return u as AdminUser;
}

/* ---------------- 登录限速（防暴力破解） ---------------- */

export function clientIp(req: Request) {
  const xf = req.headers.get("x-forwarded-for");
  if (xf) return xf.split(",").pop()!.trim() || "unknown";
  return req.headers.get("x-real-ip") || "unknown";
}

const WINDOW = 15 * 60_000;
const LOCK = 10 * 60_000;

function trying(key: string) {
  const now = Date.now();
  let t = S.tries.get(key);
  if (!t || (t.lock < now && now - t.first > WINDOW)) {
    t = { n: 0, first: now, lock: 0 };
    S.tries.set(key, t);
  }
  if (S.tries.size > 5000) for (const [k, v] of S.tries) if (v.lock < now && now - v.first > WINDOW) S.tries.delete(k);
  return t;
}

/** 返回需要等待的秒数（0 = 可以尝试） */
export function lockedFor(scope: string, ip: string) {
  const now = Date.now();
  const left = Math.max(trying(`${scope}:ip:${ip}`).lock, trying(`${scope}:all`).lock) - now;
  return left > 0 ? Math.ceil(left / 1000) : 0;
}

export function recordFailure(scope: string, ip: string) {
  const now = Date.now();
  const a = trying(`${scope}:ip:${ip}`);
  a.n++;
  if (a.n >= 5) a.lock = now + LOCK;
  const g = trying(`${scope}:all`); // 全局计数：防止伪造来源地址绕过
  g.n++;
  if (g.n >= 40) g.lock = now + 5 * 60_000;
}

export function recordSuccess(scope: string, ip: string) {
  S.tries.delete(`${scope}:ip:${ip}`);
}

export function remainingAttempts(scope: string, ip: string) {
  return Math.max(0, 5 - trying(`${scope}:ip:${ip}`).n);
}
