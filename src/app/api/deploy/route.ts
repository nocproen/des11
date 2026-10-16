import { requireAdmin } from "@/lib/auth";
import { applyUpdate, checkRemote, deployState, readLogTail, updateDeployConfig } from "@/lib/deploy";

// 服务更新接口：仅后台管理员可用，用于查看版本状态 / 手动触发更新 / 配置自动更新。
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

async function payload() {
  const st = deployState().status;
  return {
    running: st.running,
    localCommit: st.localCommit,
    remoteCommit: st.remoteCommit,
    behind: st.behind,
    updateAvailable: st.updateAvailable,
    lastCheck: st.lastCheck,
    lastRunAt: st.lastRunAt,
    lastResult: st.lastResult,
    message: st.message,
    buildId: st.buildId,
    autoUpdate: st.autoUpdate,
    restartOnUpdate: st.restartOnUpdate,
    intervalMin: st.intervalMin,
    remoteUrl: st.remoteUrl,
    branch: st.branch,
    log: st.log || (await readLogTail()),
  };
}

export async function GET(req: Request) {
  const admin = await requireAdmin(req);
  if (!admin) return json({ error: "未登录或登录已过期" }, 401);
  const { searchParams } = new URL(req.url);
  const check = searchParams.get("check") !== "0";
  if (check || !deployState().status.lastCheck) {
    await checkRemote(check);
  }
  return json(await payload());
}

export async function POST(req: Request) {
  const admin = await requireAdmin(req);
  if (!admin) return json({ error: "未登录或登录已过期" }, 401);

  const body = (await req.json().catch(() => ({}))) as {
    action?: string;
    autoUpdate?: boolean;
    restartOnUpdate?: boolean;
    intervalMin?: number;
  };
  const st = deployState().status;

  if (body.action === "check") {
    await checkRemote(true);
    return json(await payload());
  }

  if (body.action === "apply" || body.action === "force-apply") {
    if (st.running) return json({ error: "更新正在进行中" }, 409);
    await applyUpdate({ forceBuild: body.action === "force-apply" });
    return json(await payload());
  }

  if (body.action === "config") {
    updateDeployConfig({
      autoUpdate: body.autoUpdate,
      restartOnUpdate: body.restartOnUpdate,
      intervalMin: body.intervalMin,
    });
    return json(await payload());
  }

  return json({ error: "未知操作" }, 400);
}
