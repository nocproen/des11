"use client";

import { useState } from "react";

// 应用图标：优先显示真实图标图片，加载失败时退回 emoji
export function AppIcon({ url, fallback, size = 40 }: { url?: string; fallback: string; size?: number }) {
  const [badUrl, setBadUrl] = useState<string | null>(null);
  if (!url || badUrl === url) {
    return (
      <span className="drop-shadow-lg" style={{ fontSize: Math.round(size * 0.9), lineHeight: 1 }}>
        {fallback}
      </span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={url}
      alt=""
      draggable={false}
      onError={() => setBadUrl(url)}
      className="object-contain drop-shadow-lg"
      style={{ width: size, height: size }}
    />
  );
}
