import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AdminApp } from "@/components/admin-app";
import { ADMIN_SLUG } from "@/lib/auth";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "管理后台",
  robots: { index: false, follow: false, nocache: true },
};

// 后台页面：只有路径与后台路径完全一致才会渲染，其他任何单段路径都是 404
export default async function AdminPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  if (slug !== ADMIN_SLUG) notFound();
  return <AdminApp slug={slug} />;
}
