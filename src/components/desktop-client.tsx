"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Desktop from "@/components/desktop/desktop";
import { LoginScreen } from "@/components/login-screen";
import { installDesktopSession } from "@/components/desktop/client-session";

type LockState = "ready" | "unset" | "expired";

export default function DesktopClient({ lock }: { lock: LockState }) {
  const [session, setSession] = useState<string | null>(null);
  const [wasKicked, setWasKicked] = useState(false);
  const cleanup = useRef<(() => void) | null>(null);

  const leave = useCallback(() => {
    cleanup.current?.();
    cleanup.current = null;
    setSession(null);
    setWasKicked(true);
  }, []);

  const enter = useCallback((id: string) => {
    cleanup.current?.();
    cleanup.current = installDesktopSession(id, leave);
    setWasKicked(false);
    setSession(id);
  }, [leave]);

  useEffect(() => () => {
    cleanup.current?.();
    cleanup.current = null;
  }, []);

  useEffect(() => {
    if (!session) return;
    let busy = false;
    const check = async () => {
      if (busy) return;
      busy = true;
      try {
        // fetch 拦截器自动附加本页的 X-Desktop-Session；401 则立即锁屏。
        const response = await fetch("/api/auth/session", { cache: "no-store" });
        if (response.status === 401) leave();
      } catch {
        // 网络短暂离线不能误判为被踢；恢复网络后继续检查。
      } finally {
        busy = false;
      }
    };
    const onResume = () => { if (!document.hidden) void check(); };
    const timer = window.setInterval(() => void check(), 2500);
    window.addEventListener("focus", onResume);
    document.addEventListener("visibilitychange", onResume);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onResume);
      document.removeEventListener("visibilitychange", onResume);
    };
  }, [session, leave]);

  if (!session) {
    return <LoginScreen lock={lock} onAuthenticated={enter} message={wasKicked ? "此桌面已在其他页面登录，当前页面已强制下线。请重新输入密码。" : undefined} />;
  }
  return <Desktop />;
}
