import "dotenv/config";

const base = process.env.PREVIEW_BASE_URL || "http://127.0.0.1:3000";
const slug = (process.env.ADMIN_PATH || "ops-7k2m9x4q").replace(/^\/+|\/+$/g, "");
const password = process.env.ADMIN_PASSWORD;
const desktopPassword = process.env.DESKTOP_PASSWORD;
if (!password || !desktopPassword) throw new Error("Set ADMIN_PASSWORD and DESKTOP_PASSWORD in the environment before first startup.");
let cookie = "";
async function call(action, body) {
  const response = await fetch(`${base}/api/ops/${slug}/${action}`, {
    method: body ? "POST" : "GET",
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`${action}: ${JSON.stringify(data)}`);
  const nextCookie = response.headers.get("set-cookie");
  if (nextCookie) cookie = nextCookie.split(";")[0];
  return data;
}
await call("login", { username: process.env.ADMIN_USER || "admin", password });
const status = await call("state");
if (!status.desktop.set) {
  await call("desktop-password", { password: desktopPassword, expiresInMinutes: null });
  console.log("Desktop access configured through the original authenticated admin API.");
} else console.log("Existing desktop access configuration preserved.");
