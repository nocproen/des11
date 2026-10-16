"use client";

import type { DragEvent } from "react";
import type { SysEntry } from "./sys-store";
import { withDesktopAccess } from "./client-session";

// 把服务器上的文件"给到"Windows：拖出去、下载、复制图片。
// 网页没法把文件放进 Windows 剪贴板（浏览器只开放文字和 PNG 图片），所以"复制文件 → 桌面粘贴"做不到，
// 改用 Chrome / Edge 支持的 DownloadURL 拖拽：拖到 Windows 桌面或资源管理器里，松手就保存到那里。

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i;
export const isImage = (name: string) => IMAGE_EXT.test(name);

export const downloadUrl = (p: string) => withDesktopAccess(`/api/sys/download?path=${encodeURIComponent(p)}`);
export const downloadName = (e: SysEntry) => (e.kind === "folder" ? `${e.name}.zip` : e.name);

/** 在 dragstart 里调用：允许把这个文件 / 文件夹拖到 Windows（文件夹会变成 zip） */
export function allowDragOut(ev: DragEvent, e: SysEntry) {
  const mime = e.kind === "folder" ? "application/zip" : "application/octet-stream";
  // 格式：MIME:文件名:绝对网址。文件名里的冒号会破坏格式，换掉
  const name = downloadName(e).replace(/:/g, "_");
  ev.dataTransfer.setData("DownloadURL", `${mime}:${name}:${location.origin}${downloadUrl(e.path)}`);
  ev.dataTransfer.effectAllowed = "copyMove"; // 站内拖动仍是移动；拖到 Windows 是复制
}

export function downloadEntry(e: SysEntry) {
  const a = document.createElement("a");
  a.href = downloadUrl(e.path);
  a.download = downloadName(e);
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** 把图片复制到本机剪贴板（剪贴板只收 PNG，其他格式先在浏览器里转一下） */
export async function copyImage(p: string) {
  const make = async () => {
    const r = await fetch(`/api/sys/raw?path=${encodeURIComponent(p)}`, { cache: "no-store" });
    if (!r.ok) throw new Error("读取图片失败");
    const blob = await r.blob();
    if (blob.type === "image/png") return blob;
    const bmp = await createImageBitmap(blob);
    const c = document.createElement("canvas");
    c.width = bmp.width;
    c.height = bmp.height;
    c.getContext("2d")!.drawImage(bmp, 0, 0);
    return await new Promise<Blob>((ok, err) => c.toBlob((b) => (b ? ok(b) : err(new Error("转换失败"))), "image/png"));
  };
  // 传 Promise 给 ClipboardItem：Chrome 要求在点击当下就调用 write，图片可以随后再到
  await navigator.clipboard.write([new ClipboardItem({ "image/png": make() })]);
}
