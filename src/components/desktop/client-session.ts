"use client";

// 仅保存在当前页面的内存中：新标签页、重新打开网页或刷新都必须重新输密码。
// Cookie 是 HttpOnly，另加此页面独有的标识可防止同浏览器其他标签偷用新 Cookie。
let currentSession = "";

export function getDesktopSessionId() {
  return currentSession;
}

export function withDesktopAccess(url: string) {
  if (!currentSession) return url;
  return `${url}${url.includes("?") ? "&" : "?"}access=${encodeURIComponent(currentSession)}`;
}

export function installDesktopSession(sessionId: string, onInvalid: () => void) {
  currentSession = sessionId;
  const nativeFetch = window.fetch;
  let active = true;
  let fired = false;

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, window.location.href);
    const protectedApi =
      url.origin === window.location.origin &&
      url.pathname.startsWith("/api/") &&
      !url.pathname.startsWith("/api/ops/") &&
      !url.pathname.startsWith("/api/auth/login") &&
      !url.pathname.startsWith("/api/health");

    let options = init;
    if (protectedApi) {
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      headers.set("X-Desktop-Session", sessionId);
      options = { ...init, headers, cache: init?.cache ?? "no-store" };
    }

    const response = await nativeFetch(input, options);
    // 修复：只有明确的 401 才踢人，503 等服务器临时错误不应踢
    if (active && !fired && protectedApi && response.status === 401) {
      fired = true;
      onInvalid();
    }
    return response;
  };

  let channel: BroadcastChannel | null = null;
  if (typeof BroadcastChannel !== "undefined") {
    channel = new BroadcastChannel("webdesktop-exclusive-session");
    channel.onmessage = (event: MessageEvent<{ sessionId?: string; ts?: number }>) => {
      // 保证只有真正的新登录才踢人：如果收到的是自己刚发的消息（时间戳接近）不处理
      if (active && event.data?.sessionId && event.data.sessionId !== sessionId && !fired) {
        fired = true;
        onInvalid();
      }
    };
    // 发送时带时间戳，避免陈旧消息误触发
    channel.postMessage({ sessionId, ts: Date.now() });
  }

  return () => {
    active = false;
    if (window.fetch !== nativeFetch) window.fetch = nativeFetch;
    channel?.close();
    if (currentSession === sessionId) currentSession = "";
  };
}
