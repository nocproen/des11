import {
  DESKTOP_COOKIE,
  changeDesktopPasswordKeepingExpiry,
  clearCookieHeader,
  clientIp,
  denyDesktop,
  getDesktopStatus,
  lockedFor,
  recordFailure,
  recordSuccess,
  remainingAttempts,
} from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const headers = { "Cache-Control": "private, no-store" };
const json = (value: object, status = 200, extraHeaders?: Record<string, string>) =>
  Response.json(value, { status, headers: { ...headers, ...extraHeaders } });

export async function GET(req: Request) {
  const denied = await denyDesktop(req);
  if (denied) return denied;

  // 前台只看到有效期，不返回当前密码，也没有修改有效期的入口。
  const status = await getDesktopStatus();
  return json({ expiresAt: status.expiresAt, setAt: status.setAt, serverNow: Date.now() });
}

export async function POST(req: Request) {
  const denied = await denyDesktop(req);
  if (denied) return denied;

  if (req.headers.get("sec-fetch-site") === "cross-site") return json({ error: "跨站请求已拒绝" }, 403);
  if (!req.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return json({ error: "请使用 JSON 提交" }, 415);
  }

  const raw: unknown = await req.json().catch(() => null);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return json({ error: "请求格式无效" }, 400);
  const fields = raw as Record<string, unknown>;
  const allowed = new Set(["currentPassword", "newPassword", "confirmPassword"]);
  if (Object.keys(fields).some((key) => !allowed.has(key))) {
    return json({ error: "前台只能修改密码，不能修改密码到期时间" }, 400);
  }

  const { currentPassword, newPassword, confirmPassword } = fields;
  if (typeof currentPassword !== "string" || !currentPassword || currentPassword.length > 256) {
    return json({ error: "请输入当前密码" }, 400);
  }
  if (typeof newPassword !== "string" || newPassword.length < 6 || newPassword.length > 128) {
    return json({ error: "新密码需为 6–128 位" }, 400);
  }
  if (confirmPassword !== newPassword) return json({ error: "两次输入的新密码不一致" }, 400);
  if (newPassword === currentPassword) return json({ error: "新密码不能与当前密码相同" }, 400);

  const ip = clientIp(req);
  const wait = lockedFor("desktop-change", ip);
  if (wait > 0) {
    return json({ error: `尝试次数过多，请 ${Math.ceil(wait / 60)} 分钟后再试` }, 429, {
      "Retry-After": String(wait),
    });
  }

  const result = await changeDesktopPasswordKeepingExpiry(currentPassword, newPassword);
  if (result === "invalid") {
    recordFailure("desktop-change", ip);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const left = remainingAttempts("desktop-change", ip);
    return json({ error: left > 0 ? `当前密码不正确（还可尝试 ${left} 次）` : "尝试次数过多，已被临时锁定 10 分钟" }, 403);
  }
  if (result === "expired" || result === "unset") {
    return json({ error: "桌面密码已过期或被移除，请联系管理员" }, 401);
  }

  recordSuccess("desktop-change", ip);
  // 改密会让所有旧会话失效；清除本浏览器 Cookie，引导用户用新密码重新登录。
  return json({ ok: true, message: "密码已更新，有效期保持不变，请使用新密码重新登录" }, 200, {
    "Set-Cookie": clearCookieHeader(DESKTOP_COOKIE, req),
  });
}
