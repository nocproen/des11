import {
  type AnyPgColumn,
  boolean,
  integer,
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
