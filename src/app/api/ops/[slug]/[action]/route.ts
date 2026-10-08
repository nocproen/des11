import {
  ADMIN_COOKIE,
  ADMIN_MAX_AGE,
  ADMIN_SLUG,
  bumpDesktopVersion,
  clearCookieHeader,
  clearDesktopPassword,
  clientIp,
  createAdminToken,
  findAdminByName,
  getDesktopPlain,
  getDesktopStatus,
  setDesktopExpiry,
  lockedFor,
  recordFailure,
  recordSuccess,
  remainingAttempts,
  requireAdmin,
  setCookieHeader,
  setDesktopPassword,
  updateAdmin,
  verifyPassword,
} from "@/lib/auth";

// 后台接口。路径中必须带正确的后台路径(slug)，否则一律返回 404，不暴露后台存在。

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ slug: string; action: string }> };

const json = (body: object, status = 200, headers?: Record<string, string>) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// 有效期：分钟数（从现在起算）；null / 0 / 未提供 = 永久有效
function parseExpiry(v: unknown): number | null | "bad" {
  if (v === null || v === undefined || v === 0 || v === "forever") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > 3650 * 24 * 60) return "bad";
  return Date.now() + n * 60_000;
}
const USER_RE = /^[A-Za-z0-9_.-]{3,32}$/;

async function handle(req: Request, ctx: Ctx, method: "GET" | "POST") {
  const { slug, action } = await ctx.params;
  if (slug !== ADMIN_SLUG) return json({ error: "Not found" }, 404);

  const body = method === "POST" ? ((await req.json().catch(() => ({}))) as Record<string, unknown>) : {};
  const str = (k: string) => (typeof body[k] === "string" ? (body[k] as string) : "");

  if (action === "login" && method === "POST") {
    const ip = clientIp(req);
    const wait = lockedFor("admin", ip);
    if (wait > 0) return json({ error: `尝试次数过多，请 ${Math.ceil(wait / 60)} 分钟后再试` }, 429);
    const username = str("username").trim();
    const password = str("password");
    if (!username || !password || username.length > 64 || password.length > 256) {
      return json({ error: "请输入账号和密码" }, 400);
    }
    const user = await findAdminByName(username);
    const ok = await verifyPassword(password, user?.passwordHash);
    if (!user || !ok) {
      recordFailure("admin", ip);
      await sleep(600);
      const left = remainingAttempts("admin", ip);
      return json({ error: left > 0 ? `账号或密码不正确（还可尝试 ${left} 次）` : "尝试次数过多，已被临时锁定 10 分钟" }, 401);
    }
    recordSuccess("admin", ip);
    const token = await createAdminToken(user);
    return json({ ok: true, mustChange: user.mustChange }, 200, {
      "Set-Cookie": setCookieHeader(ADMIN_COOKIE, token, req, ADMIN_MAX_AGE),
    });
  }

  if (action === "logout" && method === "POST") {
    return json({ ok: true }, 200, { "Set-Cookie": clearCookieHeader(ADMIN_COOKIE, req) });
  }

  // 以下接口都需要管理员登录
  const admin = await requireAdmin(req);
  if (!admin) return json({ error: "未登录或登录已过期" }, 401);

  if (action === "state" && method === "GET") {
    const desktop = await getDesktopStatus();
    return json({
      username: admin.username,
      mustChange: admin.mustChange,
      desktop,
      // 当前桌面密码明文：仅在管理员已改掉默认密码后返回
      desktopPassword: !admin.mustChange && desktop.set ? await getDesktopPlain() : null,
      serverNow: Date.now(),
    });
  }

  if (action === "account" && method === "POST") {
    const current = str("currentPassword");
    if (!(await verifyPassword(current, admin.passwordHash))) {
      await sleep(600);
      return json({ error: "当前密码不正确" }, 403);
    }
    const newUser = str("username").trim();
    const newPass = str("newPassword");
    const patch: { username?: string; password?: string } = {};
    if (newUser && newUser !== admin.username) {
      if (!USER_RE.test(newUser)) return json({ error: "账号需为 3–32 位字母、数字、下划线、点或短横线" }, 400);
      const exists = await findAdminByName(newUser);
      if (exists) return json({ error: "该账号名已被使用" }, 409);
      patch.username = newUser;
    }
    if (newPass) {
      if (newPass.length < 8 || newPass.length > 128) return json({ error: "新密码长度需为 8–128 位" }, 400);
      if (newPass === current) return json({ error: "新密码不能与当前密码相同" }, 400);
      patch.password = newPass;
    }
    if (admin.mustChange && !patch.password) return json({ error: "首次登录必须修改密码" }, 400);
    if (!patch.username && !patch.password) return json({ error: "没有需要修改的内容" }, 400);
    const updated = await updateAdmin(admin.id, patch);
    // 密码变了，旧令牌作废；给当前浏览器签发新令牌
    const token = await createAdminToken(updated);
    return json({ ok: true, username: updated.username }, 200, {
      "Set-Cookie": setCookieHeader(ADMIN_COOKIE, token, req, ADMIN_MAX_AGE),
    });
  }

  if (admin.mustChange) return json({ error: "请先修改默认的后台密码" }, 403);

  if (action === "desktop-password" && method === "POST") {
    if (body.clear === true) {
      await clearDesktopPassword();
      return json({ ok: true });
    }
    const pw = str("password");
    if (pw.length < 6 || pw.length > 128) return json({ error: "桌面密码长度需为 6–128 位" }, 400);
    const exp = parseExpiry(body.expiresInMinutes);
    if (exp === "bad") return json({ error: "有效期无效（1 分钟 ~ 10 年，或选择永久）" }, 400);
    await setDesktopPassword(pw, exp); // 同时让所有已登录的桌面下线
    return json({ ok: true });
  }

  if (action === "desktop-expiry" && method === "POST") {
    if (!(await getDesktopStatus()).set) return json({ error: "还没有设置桌面密码" }, 400);
    const exp = parseExpiry(body.expiresInMinutes);
    if (exp === "bad") return json({ error: "有效期无效（1 分钟 ~ 10 年，或选择永久）" }, 400);
    await setDesktopExpiry(exp);
    return json({ ok: true });
  }

  if (action === "kick" && method === "POST") {
    await bumpDesktopVersion();
    return json({ ok: true });
  }

  return json({ error: "Not found" }, 404);
}

export const GET = (req: Request, ctx: Ctx) => handle(req, ctx, "GET");
export const POST = (req: Request, ctx: Ctx) => handle(req, ctx, "POST");
