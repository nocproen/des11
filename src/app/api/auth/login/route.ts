import {
  DESKTOP_COOKIE,
  checkDesktopPassword,
  clientIp,
  createDesktopToken,
  getDesktopStatus,
  lockedFor,
  recordFailure,
  recordSuccess,
  remainingAttempts,
  setCookieHeader,
} from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function POST(req: Request) {
  const ip = clientIp(req);
  const wait = lockedFor("desk", ip);
  if (wait > 0) {
    return Response.json(
      { error: `尝试次数过多，请 ${Math.ceil(wait / 60)} 分钟后再试`, retryAfter: wait },
      { status: 429, headers: { "Retry-After": String(wait) } },
    );
  }

  const b = (await req.json().catch(() => null)) as { password?: unknown; remember?: unknown } | null;
  if (!b || typeof b.password !== "string" || b.password.length === 0 || b.password.length > 256) {
    return Response.json({ error: "请输入密码" }, { status: 400 });
  }

  const st = await getDesktopStatus();
  if (!st.set) {
    return Response.json({ error: "桌面尚未设置访问密码，请联系管理员", notSet: true }, { status: 503 });
  }
  if (st.expired) {
    return Response.json({ error: "访问密码已过期，请联系管理员重新设置或续期", expired: true }, { status: 403 });
  }

  if (!(await checkDesktopPassword(b.password))) {
    recordFailure("desk", ip);
    await sleep(500);
    const left = remainingAttempts("desk", ip);
    return Response.json(
      { error: left > 0 ? `密码不正确（还可尝试 ${left} 次）` : "尝试次数过多，已被临时锁定 10 分钟" },
      { status: 401 },
    );
  }

  recordSuccess("desk", ip);
  const { token, maxAge } = await createDesktopToken(b.remember !== false);
  return Response.json(
    { ok: true },
    { headers: { "Set-Cookie": setCookieHeader(DESKTOP_COOKIE, token, req, maxAge), "Cache-Control": "no-store" } },
  );
}
