import type { Metadata } from "next";
import { TargetOverview } from "@/features/targets/components/target-overview";

export const metadata: Metadata = { title: "Target overview" };

export default async function TargetPage({ params }: PageProps<"/targets/[targetId]">) {
  const { targetId } = await params;
  return <TargetOverview targetId={targetId} />;
}
