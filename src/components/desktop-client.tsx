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
    let consecutiveErrors = 0;
    const check = async () => {
      if (busy) return;
      busy = true;
      try {
        const response = await fetch("/api/auth/session", { cache: "no-store" });
        if (response.status === 401) {
          // 被踢：其他设备登录或密码过期
          leave();
          return;
        }
        if (response.ok) {
          consecutiveErrors = 0;
          return;
        }
        // 503 等临时错误不踢人，只记录
        if (response.status >= 500) {
          consecutiveErrors++;
          return;
        }
        // 其他 4xx 也视为踢人
        if (response.status === 401) leave();
      } catch {
        // 网络短暂离线不能误判为被踢；恢复网络后继续检查。
        consecutiveErrors++;
      } finally {
        busy = false;
      }
    };
    const onResume = () => { if (!document.hidden) void check(); };
    // 延长心跳到 8 秒，降低服务器压力，避免频繁误判
    const timer = window.setInterval(() => void check(), 8000);
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
