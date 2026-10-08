import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["playwright-core", "ws", "sharp", "node-pty"],
};

export default nextConfig;
