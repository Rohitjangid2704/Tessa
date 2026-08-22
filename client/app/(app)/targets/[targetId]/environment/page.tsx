import type { Metadata } from "next";
import { EnvironmentView } from "@/features/environment/components/environment-view";

export const metadata: Metadata = { title: "Environment" };

export default async function EnvironmentPage({
  params,
}: PageProps<"/targets/[targetId]/environment">) {
  const { targetId } = await params;
  return <EnvironmentView targetId={targetId} />;
}
