export const WALLPAPERS = [
  {
    id: "img1",
    name: "晨曦湖畔",
    css: "url(/wallpapers/1.jpg) center / cover no-repeat",
  },
  {
    id: "img2",
    name: "霓虹流光",
    css: "url(/wallpapers/2.jpg) center / cover no-repeat",
  },
  {
    id: "img3",
    name: "夜幕之城",
    css: "url(/wallpapers/3.jpg) center / cover no-repeat",
  },
  {
    id: "aurora",
    name: "极光",
    css: "radial-gradient(ellipse at 20% 20%, #34d399 0%, transparent 45%), radial-gradient(ellipse at 80% 30%, #6366f1 0%, transparent 50%), linear-gradient(160deg, #0f172a, #1e1b4b)",
  },
  {
    id: "sunset",
    name: "落日",
    css: "radial-gradient(circle at 70% 85%, #fde68a 0%, transparent 35%), linear-gradient(180deg, #7c3aed 0%, #db2777 55%, #fb923c 100%)",
  },
  {
    id: "midnight",
    name: "午夜",
    css: "radial-gradient(ellipse at 50% 120%, #1d4ed8 0%, transparent 60%), linear-gradient(180deg, #020617, #0f172a)",
  },
] as const;

export const ACCENTS = [
  { id: "blue", color: "#3b82f6" },
  { id: "violet", color: "#8b5cf6" },
  { id: "rose", color: "#f43f5e" },
  { id: "emerald", color: "#10b981" },
  { id: "amber", color: "#f59e0b" },
  { id: "cyan", color: "#06b6d4" },
] as const;

export function wallpaperCss(settings: Record<string, string>) {
  const w = settings.wallpaper ?? "img1";
  if (w === "custom" && settings.customWallpaper) {
    const url = settings.customWallpaper.replace(/["')\\]/g, "");
    return `url("${url}") center / cover no-repeat`;
  }
  return (WALLPAPERS.find((x) => x.id === w) ?? WALLPAPERS[0]).css;
}

export function accentColor(settings: Record<string, string>) {
  return (ACCENTS.find((a) => a.id === settings.accent) ?? ACCENTS[0]).color;
}

export function nodeIcon(name: string, kind: string, isRoot = false) {
  if (isRoot) {
    return (
      { Desktop: "🖥️", Documents: "📚", Downloads: "⬇️", Pictures: "🖼️", Trash: "🗑️" }[name] ??
      "📁"
    );
  }
  if (kind === "folder") return "📁";
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (["png", "jpg", "jpeg", "gif", "svg", "webp"].includes(ext)) return "🖼️";
  if (["md", "markdown"].includes(ext)) return "📝";
  if (["js", "ts", "tsx", "jsx", "py", "sh", "json", "html", "css"].includes(ext)) return "📜";
  return "📄";
}
