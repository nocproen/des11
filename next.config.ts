import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 构建号用于区分部署后的网页会话（旧页面会自动刷新到新代码）。
  env: {
    NEXT_PUBLIC_WD_BUILD: Date.now().toString(36),
  },
  serverExternalPackages: ["playwright-core", "ws", "sharp", "node-pty"],
};

export default nextConfig;
