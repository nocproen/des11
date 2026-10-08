import fsp from "fs/promises";
import os from "os";

type Proc = {
  pid: number;
  ppid: number;
  name: string;
  state: string;
  ticks: number;
  rss: number;
  uid: number;
  cmd: string;
};

async function snapshot() {
  const m = new Map<number, Proc>();
  let names: string[];
  try {
    names = await fsp.readdir("/proc");
  } catch {
    return m;
  }
  await Promise.all(
    names
      .filter((n) => /^\d+$/.test(n))
      .map(async (n) => {
        try {
          const [stat, st] = await Promise.all([
            fsp.readFile(`/proc/${n}/stat`, "utf8"),
            fsp.stat(`/proc/${n}`),
          ]);
          const lp = stat.lastIndexOf(")");
          const name = stat.slice(stat.indexOf("(") + 1, lp);
          const f = stat.slice(lp + 2).split(" ");
          let cmd = "";
          try {
            cmd = (await fsp.readFile(`/proc/${n}/cmdline`, "utf8")).replace(/\0/g, " ").trim();
          } catch {
            /* ignore */
          }
          m.set(Number(n), {
            pid: Number(n),
            ppid: Number(f[1]),
            name,
            state: f[0],
            ticks: Number(f[11]) + Number(f[12]),
            rss: Number(f[21]) * 4096,
            uid: st.uid,
            cmd: cmd || `[${name}]`,
          });
        } catch {
          /* 进程已退出 */
        }
      }),
  );
  return m;
}

async function cpuTimes() {
  try {
    const line = (await fsp.readFile("/proc/stat", "utf8")).split("\n")[0];
    const v = line.trim().split(/\s+/).slice(1).map(Number);
    const total = v.slice(0, 8).reduce((a, b) => a + b, 0);
    return { total, idle: v[3] + (v[4] || 0) };
  } catch {
    return null;
  }
}

async function userMap() {
  const map = new Map<number, string>();
  try {
    for (const line of (await fsp.readFile("/etc/passwd", "utf8")).split("\n")) {
      const p = line.split(":");
      if (p.length > 2) map.set(Number(p[2]), p[0]);
    }
  } catch {
    /* ignore */
  }
  return map;
}

export async function memInfo() {
  const total = os.totalmem();
  const r = { total, available: os.freemem(), swapTotal: 0, swapFree: 0 };
  try {
    const txt = await fsp.readFile("/proc/meminfo", "utf8");
    const get = (k: string) => {
      const m = new RegExp(`^${k}:\\s+(\\d+)`, "m").exec(txt);
      return m ? Number(m[1]) * 1024 : 0;
    };
    r.total = get("MemTotal") || total;
    r.available = get("MemAvailable") || r.available;
    r.swapTotal = get("SwapTotal");
    r.swapFree = get("SwapFree");
  } catch {
    /* ignore */
  }
  return r;
}

export async function sampleSystem() {
  const t0 = Date.now();
  const s0 = await snapshot();
  const c0 = await cpuTimes();
  await new Promise((r) => setTimeout(r, 300));
  const s1 = await snapshot();
  const c1 = await cpuTimes();
  const dt = Math.max(0.05, (Date.now() - t0) / 1000);
  const users = await userMap();
  const mem = await memInfo();

  let cpu: number;
  if (c0 && c1 && c1.total > c0.total) {
    cpu = (1 - (c1.idle - c0.idle) / (c1.total - c0.total)) * 100;
  } else {
    cpu = Math.min(100, (os.loadavg()[0] / Math.max(1, os.cpus().length)) * 100);
  }

  const procs = [...s1.values()].map((p) => {
    const prev = s0.get(p.pid);
    const cpuPct = prev ? ((p.ticks - prev.ticks) / (100 * dt)) * 100 : 0;
    return {
      pid: p.pid,
      ppid: p.ppid,
      name: p.name,
      state: p.state,
      user: users.get(p.uid) ?? String(p.uid),
      cpu: Math.max(0, Math.round(cpuPct * 10) / 10),
      mem: Math.round((p.rss / mem.total) * 1000) / 10,
      rss: p.rss,
      cmd: p.cmd,
    };
  });
  procs.sort((a, b) => b.cpu - a.cpu || b.rss - a.rss);

  return { cpu: Math.max(0, Math.min(100, cpu)), procs, total: procs.length, mem };
}
