import { cookies } from "next/headers";
import Desktop from "@/components/desktop/desktop";
import { LoginScreen } from "@/components/login-screen";
import { DESKTOP_COOKIE, getDesktopStatus, verifyDesktopToken } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const token = (await cookies()).get(DESKTOP_COOKIE)?.value;
  let authed = false;
  let lock: "ready" | "unset" | "expired" = "unset";
  try {
    authed = await verifyDesktopToken(token);
    if (!authed) {
      const st = await getDesktopStatus();
      lock = !st.set ? "unset" : st.expired ? "expired" : "ready";
    }
  } catch {
    authed = false;
  }
  // 未登录时服务器只返回锁屏页，不会下发桌面界面
  return authed ? <Desktop /> : <LoginScreen lock={lock} />;
}
