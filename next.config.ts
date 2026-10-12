import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 每次构建一个新编号，前端和服务端都内联同一个值；服务端据此识别"还在跑旧代码的网页"并让它自动刷新
  env: { NEXT_PUBLIC_WD_BUILD: Date.now().toString(36) },
  serverExternalPackages: ["playwright-core", "ws", "sharp", "node-pty"],
};

export default nextConfig;
