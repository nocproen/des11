import DesktopClient from "@/components/desktop-client";
import { getDesktopStatus } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  let lock: "ready" | "unset" | "expired" = "unset";
  try {
    const status = await getDesktopStatus();
    lock = !status.set ? "unset" : status.expired ? "expired" : "ready";
  } catch {
    // 数据库暂时不可用时始终保持锁屏。
  }
  // 不根据旧 Cookie 渲染桌面：每次重新打开或刷新页面都必须手动输入密码。
  return <DesktopClient lock={lock} />;
}
