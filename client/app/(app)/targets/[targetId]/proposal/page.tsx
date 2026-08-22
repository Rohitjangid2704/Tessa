import type { Metadata } from "next";
import { ProposalView } from "@/features/proposals/components/proposal-view";

export const metadata: Metadata = { title: "Proposal" };

export default async function ProposalPage({ params }: PageProps<"/targets/[targetId]/proposal">) {
  const { targetId } = await params;
  return <ProposalView targetId={targetId} />;
}
