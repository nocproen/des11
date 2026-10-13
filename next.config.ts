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
    // Source archives often omit .git; the updater will offer a manual upstream sync.
    return "";
  }
}

const nextConfig: NextConfig = {
  // A unique build ID plus the source commit lets the admin compare packaged deployments.
  env: {
    NEXT_PUBLIC_WD_BUILD: Date.now().toString(36),
    NEXT_PUBLIC_WD_COMMIT: resolveBuildCommit(),
  },
  serverExternalPackages: ["playwright-core", "ws", "sharp", "node-pty"],
};

export default nextConfig;
