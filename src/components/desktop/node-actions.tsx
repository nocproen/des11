"use client";

import type { DragEvent } from "react";
import type { MenuItem } from "./context-menu";
import { useDialogs } from "./dialogs";
import { useFs, type FsNode } from "./fs-store";
import { useWm } from "./wm-store";

const DRAG_KEY = "application/x-node-id";

// 桌面与文件管理器共用的文件操作
export function useNodeActions() {
  const fs = useFs();
  const wm = useWm();
  const dlg = useDialogs();

  const openNode = (node: FsNode, onFolder?: (n: FsNode) => void) => {
    if (node.kind === "folder") {
      if (onFolder) onFolder(node);
      else wm.open("files", { folderId: node.id });
    } else {
      wm.open("notepad", { fileId: node.id });
    }
  };

  const rename = async (node: FsNode) => {
    if (node.parentId === null) return dlg.toast("系统文件夹不可重命名");
    const name = await dlg.prompt({ title: "重命名", value: node.name });
    if (name && name.trim() && name !== node.name) await fs.rename(node.id, name);
  };

  const newItem = async (parentId: number, kind: "folder" | "file") => {
    const name = await dlg.prompt({
      title: kind === "folder" ? "新建文件夹" : "新建文本文档",
      value: kind === "folder" ? "新建文件夹" : "新建文本文档.txt",
      confirmText: "创建",
    });
    if (!name || !name.trim()) return null;
    const node = await fs.create(parentId, name, kind);
    return node;
  };

  const trash = async (node: FsNode) => {
    if (node.parentId === null) return dlg.toast("系统文件夹不可删除");
    if (await fs.trash(node.id)) {
      wm.closeFile(node.id);
      dlg.toast(fs.isInTrash(node.id) ? "已移到回收站" : "已彻底删除");
    }
  };

  const destroy = async (node: FsNode) => {
    const ok = await dlg.confirm({
      title: "永久删除",
      message: `确定要永久删除「${node.name}」吗？此操作无法撤销。`,
      danger: true,
      confirmText: "永久删除",
    });
    if (ok && (await fs.destroy(node.id))) wm.closeFile(node.id);
  };

  const menuFor = (node: FsNode, onFolder?: (n: FsNode) => void): MenuItem[] => {
    if (node.parentId === null) {
      return [{ label: "打开", icon: "📂", onClick: () => openNode(node, onFolder) }];
    }
    if (fs.isInTrash(node.id)) {
      return [
        { label: "还原", icon: "↩️", onClick: () => void fs.restore(node.id) },
        { divider: true },
        { label: "永久删除", icon: "❌", danger: true, onClick: () => void destroy(node) },
      ];
    }
    return [
      { label: "打开", icon: "📂", onClick: () => openNode(node, onFolder) },
      { label: "重命名", icon: "✏️", onClick: () => void rename(node) },
      { divider: true },
      { label: "删除", icon: "🗑️", danger: true, onClick: () => void trash(node) },
    ];
  };

  const dragProps = (node: FsNode) => ({
    draggable: node.parentId !== null,
    onDragStart: (e: DragEvent) => {
      e.dataTransfer.setData(DRAG_KEY, String(node.id));
      e.dataTransfer.effectAllowed = "move";
    },
  });

  // 让某个文件夹（或回收站）接收拖拽进来的文件
  const dropProps = (target: FsNode | undefined) => ({
    onDragOver: (e: DragEvent) => {
      if (target && target.kind === "folder" && e.dataTransfer.types.includes(DRAG_KEY)) {
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "move";
      }
    },
    onDrop: async (e: DragEvent) => {
      const raw = e.dataTransfer.getData(DRAG_KEY);
      if (!target || !raw) return;
      e.preventDefault();
      e.stopPropagation();
      const id = Number(raw);
      if (id === target.id) return;
      if (target.id === fs.trashId) {
        const n = fs.get(id);
        if (n) await trash(n);
      } else {
        await fs.move(id, target.id);
      }
    },
  });

  return { openNode, rename, newItem, trash, destroy, menuFor, dragProps, dropProps };
}
