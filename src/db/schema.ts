import {
  type AnyPgColumn,
  boolean,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

// 虚拟文件系统：parent_id 为空表示位于根目录（系统文件夹）
export const fsNodes = pgTable("fs_nodes", {
  id: serial("id").primaryKey(),
  parentId: integer("parent_id").references((): AnyPgColumn => fsNodes.id, {
    onDelete: "cascade",
  }),
  name: text("name").notNull(),
  kind: text("kind").notNull(), // "folder" | "file"
  content: text("content").notNull().default(""),
  trashedFrom: integer("trashed_from"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// 桌面设置（壁纸、主题色、时钟格式等）
export const desktopSettings = pgTable("desktop_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

// 认证配置：桌面密码哈希、会话密钥、会话版本号等
export const authConfig = pgTable("auth_config", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

// 后台管理员账号（与桌面密码完全独立）
export const adminUsers = pgTable("admin_users", {
  id: serial("id").primaryKey(),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  mustChange: boolean("must_change").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// 全体桌面用户共用的一份屏幕快照：窗口、层级、大小、最小化状态等。
// 版本号用于防止较慢的旧请求覆盖较新的桌面画面。
export const desktopWorkspace = pgTable("desktop_workspace", {
  id: integer("id").primaryKey(),
  snapshot: jsonb("snapshot").notNull(),
  version: integer("version").notNull().default(1),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
