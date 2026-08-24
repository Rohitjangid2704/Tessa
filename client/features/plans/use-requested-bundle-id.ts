import { useSearchParams } from "next/navigation";
import { z } from "zod";
import { BUNDLE_ID_PARAM } from "@/features/catalog/queries";

const NO_SEARCH_PARAMS = new URLSearchParams();
const bundleIdSchema = z.guid();

export function useRequestedBundleId(): string | null {
  const searchParams = useSearchParams() ?? NO_SEARCH_PARAMS;
  const parsed = bundleIdSchema.safeParse(searchParams.get(BUNDLE_ID_PARAM));
  return parsed.success ? parsed.data : null;
}
