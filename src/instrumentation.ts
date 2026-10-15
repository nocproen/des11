export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { installBrowserWs } = await import("./lib/browser-ws");
  installBrowserWs();

  // 首次部署：用环境变量初始化桌面访问密码（已设置过则不覆盖）
  try {
    const { ensureAuthTables, isDesktopPasswordSet, setDesktopPassword } = await import("./lib/auth");
    await ensureAuthTables();
    if (process.env.DESKTOP_PASSWORD && !(await isDesktopPasswordSet())) {
      await setDesktopPassword(process.env.DESKTOP_PASSWORD, null);
      console.log("[deploy] 已初始化桌面访问密码");
    }
  } catch (e) {
    console.error("[deploy] 初始化桌面密码失败", e);
  }

  // 自动更新模块已按部署要求移除：本实例不再跟踪上游仓库、不拉取源码、不自动重建。
}
