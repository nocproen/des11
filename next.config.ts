import { execFileSync } from "node:child_process";
import type { NextConfig } from "next";

function resolveBuildCommit() {
  const fromEnvironment = [
    process.env.NEXT_PUBLIC_WD_COMMIT,
    process.env.VERCEL_GIT_COMMIT_SHA,
    process.env.GITHUB_SHA,
  ].find((value) => value?.trim());
  if (fromEnvironment) return fromEnvironment.trim();

  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

const nextConfig: NextConfig = {
  // 构建号与源码提交号用于区分部署版本及支持自动更新比对。
  env: {
    NEXT_PUBLIC_WD_BUILD: Date.now().toString(36),
    NEXT_PUBLIC_WD_COMMIT: resolveBuildCommit(),
  },
  serverExternalPackages: ["playwright-core", "ws", "sharp", "node-pty"],
};

export default nextConfig;
