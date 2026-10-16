// 自动更新已移除：保留空桩以兼容旧引用，避免运行时错误。
export type DeployStatus = {
  running: boolean;
  localCommit: string;
  remoteCommit: string;
  behind: number;
  updateAvailable: boolean;
  lastCheck: number | null;
  lastRunAt: number | null;
  lastResult: "ok" | "error" | null;
  message: string;
  log: string;
  buildId: string;
  autoUpdate: boolean;
  restartOnUpdate: boolean;
  intervalMin: number;
  remoteUrl: string;
  branch: string;
};

export function deployState(): { status: DeployStatus; timer?: NodeJS.Timeout } {
  return {
    status: {
      running: false,
      localCommit: "",
      remoteCommit: "",
      behind: 0,
      updateAvailable: false,
      lastCheck: null,
      lastRunAt: null,
      lastResult: null,
      message: "自动更新已禁用",
      log: "",
      buildId: "",
      autoUpdate: false,
      restartOnUpdate: false,
      intervalMin: 0,
      remoteUrl: "",
      branch: "",
    },
  };
}
export async function readLogTail(): Promise<string> { return ""; }
export async function checkRemote(): Promise<DeployStatus> { return deployState().status; }
export async function applyUpdate(): Promise<DeployStatus> { return deployState().status; }
export function updateDeployConfig(): DeployStatus { return deployState().status; }
export function startDeployWatcher() {}
