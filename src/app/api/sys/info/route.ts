import { denyDesktop } from "@/lib/auth";
import fsp from "fs/promises";
import os from "os";
import { DESKTOP, DOCUMENTS, DOWNLOADS, HOME, PICTURES, TRASH_FILES, ensureHome } from "@/lib/sys";
import { sampleSystem } from "@/lib/procfs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function osName() {
  try {
    const t = await fsp.readFile("/etc/os-release", "utf8");
    const m = /^PRETTY_NAME="?([^"\n]+)"?/m.exec(t);
    if (m) return m[1];
  } catch {
    /* ignore */
  }
  return `${os.type()} ${os.release()}`;
}

function username() {
  try {
    return os.userInfo().username;
  } catch {
    return process.env.USER ?? "user";
  }
}

export async function GET(req: Request) {
  const denied = await denyDesktop(req);
  if (denied) return denied;
  await ensureHome();
  const lite = new URL(req.url).searchParams.get("lite") === "1";
  const base = {
    user: username(),
    host: os.hostname(),
    home: HOME,
    desktop: DESKTOP,
    documents: DOCUMENTS,
    downloads: DOWNLOADS,
    pictures: PICTURES,
    trash: TRASH_FILES,
    os: await osName(),
  };
  if (lite) return Response.json(base);

  const s = await sampleSystem();
  let disk: { total: number; free: number } | null = null;
  try {
    const st = await fsp.statfs("/");
    disk = { total: st.blocks * st.bsize, free: st.bavail * st.bsize };
  } catch {
    /* ignore */
  }
  const cpus = os.cpus();
  const nets = Object.entries(os.networkInterfaces()).flatMap(([name, list]) =>
    (list ?? []).map((n) => ({
      name,
      address: n.address,
      family: String(n.family),
      mac: n.mac,
      internal: n.internal,
    })),
  );

  return Response.json({
    ...base,
    kernel: os.release(),
    arch: os.arch(),
    platform: os.platform(),
    node: process.version,
    uptime: os.uptime(),
    cpuModel: cpus[0]?.model ?? "unknown",
    cores: cpus.length,
    load: os.loadavg(),
    cpu: s.cpu,
    mem: s.mem,
    disk,
    nets,
    processTotal: s.total,
    procs: s.procs.slice(0, 120),
    selfPid: process.pid,
  });
}
