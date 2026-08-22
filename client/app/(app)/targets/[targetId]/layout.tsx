import { TargetFrame } from "@/features/targets/components/target-frame";

export default async function TargetLayout({
  children,
  params,
}: LayoutProps<"/targets/[targetId]">) {
  const { targetId } = await params;
  return <TargetFrame targetId={targetId}>{children}</TargetFrame>;
}
