import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "WebDesktop — 浏览器里的桌面系统",
  description: "模拟桌面系统：窗口管理、文件管理器、终端、记事本，数据持久化于 PostgreSQL。",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body className="overflow-hidden bg-slate-950 text-slate-100 antialiased">{children}</body>
    </html>
  );
}
