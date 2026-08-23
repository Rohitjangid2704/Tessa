import { z } from "zod";
import { targetIdParam } from "@/features/targets/target-id-param";
import type { ContractCheckCreate, VerdictStatus } from "@/lib/api/types";
import { createSearchParamsCodec, enumListParam, uuidParam } from "@/lib/search-params";
import { CONTRACT_VERDICT_ORDER } from "./model";

export const CONTRACT_VERDICT_FILTER_VALUES = [
  ...CONTRACT_VERDICT_ORDER,
] as const satisfies readonly VerdictStatus[];

export const contractCheckFormSchema = z.object({
  consumer_bundle_id: z.string().min(1, "Choose the consumer bundle version"),
  provider_bundle_id: z.string().min(1, "Choose the provider bundle version"),
}) satisfies z.ZodType<ContractCheckCreate>;

export type ContractCheckFormValues = z.infer<typeof contractCheckFormSchema>;

export const CONTRACT_FORM_FIELDS = ["consumer_bundle_id", "provider_bundle_id"] as const;

export const contractListFiltersCodec = createSearchParamsCodec({
  consumer_target_id: targetIdParam(),
  provider_target_id: targetIdParam(),
});

export const contractPrefillCodec = createSearchParamsCodec({
  consumer_bundle_id: uuidParam(),
  provider_bundle_id: uuidParam(),
});

export const contractItemFiltersCodec = createSearchParamsCodec({
  verdict: enumListParam(CONTRACT_VERDICT_FILTER_VALUES),
});

export type ContractListFilterValues = ReturnType<typeof contractListFiltersCodec.parse>;

export type ContractItemFilterValues = ReturnType<typeof contractItemFiltersCodec.parse>;
