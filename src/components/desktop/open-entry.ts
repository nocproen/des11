import type { MenuItem } from "./context-menu";
import { dirName, type SysEntry } from "./sys-store";
import type { useWm } from "./wm-store";

type Wm = ReturnType<typeof useWm>;

export const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
export const isDesktopFile = (n: string) => /\.desktop$/i.test(n);
export const isAppImage = (n: string) => /\.AppImage$/i.test(n);
export const isDeb = (n: string) => /\.deb$/i.test(n);

type Meta = { name?: string; iconUrl?: string };

function installDeb(wm: Wm, en: SysEntry) {
  // 在终端里执行安装：apt 会问 [Y/n]，终端是真正的交互式终端，可以直接回答
  wm.open("systerm", { path: dirName(en.path), cmd: `sudo apt install ${shq("./" + en.name)}` });
}

function runAppImage(wm: Wm, en: SysEntry) {
  wm.open("gui", { cmd: shq(en.path), path: dirName(en.path), name: en.name.replace(/\.AppImage$/i, "") });
}

/** 双击一个文件 / 文件夹时的默认动作 */
export function openEntry(wm: Wm, en: SysEntry, meta?: Meta) {
  if (en.kind === "folder") return wm.open("sysfiles", { path: en.path });
  if (isDesktopFile(en.name)) {
    return wm.open("gui", { desktopFile: en.path, name: meta?.name, iconUrl: meta?.iconUrl });
  }
  if (isAppImage(en.name)) return runAppImage(wm, en);
  if (isDeb(en.name)) return installDeb(wm, en);
  return wm.open("sysedit", { path: en.path });
}

/** 右键菜单里针对软件包 / 应用的额外项 */
export function entryExtraMenu(wm: Wm, en: SysEntry): MenuItem[] {
  if (en.kind !== "file") return [];
  if (isDeb(en.name)) return [{ label: "安装软件包（终端）", icon: "📦", onClick: () => installDeb(wm, en) }];
  if (isAppImage(en.name)) return [{ label: "运行应用", icon: "🚀", onClick: () => runAppImage(wm, en) }];
  if (isDesktopFile(en.name)) {
    return [{ label: "用文本编辑器打开", icon: "📝", onClick: () => wm.open("sysedit", { path: en.path }) }];
  }
  return [];
}
