import type { Metadata } from "next";
import { BundleDetail } from "@/features/bundles/components/bundle-detail";

export const metadata: Metadata = { title: "Bundle version" };

const BUNDLE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function readAgainst(value: string | string[] | undefined): string | null {
  const candidate = Array.isArray(value) ? value[0] : value;
  return candidate !== undefined && BUNDLE_ID_PATTERN.test(candidate)
    ? candidate.toLowerCase()
    : null;
}

export default async function BundleDetailPage({
  params,
  searchParams,
}: PageProps<"/targets/[targetId]/bundles/[bundleId]">) {
  const { targetId, bundleId } = await params;
  const query = await searchParams;
  return (
    <BundleDetail targetId={targetId} bundleId={bundleId} against={readAgainst(query.against)} />
  );
}
