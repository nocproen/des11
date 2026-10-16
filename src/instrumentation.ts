export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { installBrowserWs } = await import("./lib/browser-ws");
  installBrowserWs();

  // 首次部署：用环境变量初始化认证表与桌面访问密码（已设置过则不覆盖）
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

  // 服务自动更新巡检：GitHub 源码有变化就自动拉取、同步数据库并重新构建
  try {
    const { startDeployWatcher } = await import("./lib/deploy");
    startDeployWatcher();
  } catch (e) {
    console.error("[deploy] 启动自动更新巡检失败", e);
  }
}
