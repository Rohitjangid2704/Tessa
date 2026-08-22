import type { Metadata } from "next";
import { BundleIntake } from "@/features/bundles/components/bundle-intake";
import { GitPullPanel } from "@/features/bundles/components/git-pull-panel";

export const metadata: Metadata = { title: "Bundles" };

export default async function BundlesPage({ params }: PageProps<"/targets/[targetId]/bundles">) {
  const { targetId } = await params;
  return (
    <div className="flex flex-col gap-10">
      <GitPullPanel targetId={targetId} />
      <BundleIntake targetId={targetId} />
    </div>
  );
}
