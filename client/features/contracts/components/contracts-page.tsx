"use client";

import { useUrlFilters } from "@/lib/url-state";
import { contractPrefillCodec } from "../schemas";
import { CheckForm } from "./check-form";
import { CheckList } from "./check-list";

export function ContractsPage() {
  const { values } = useUrlFilters(contractPrefillCodec);
  const consumerBundleId = values.consumer_bundle_id;
  const providerBundleId = values.provider_bundle_id;

  return (
    <div data-slot="contracts-page" className="flex min-w-0 flex-col gap-10">
      <CheckForm
        key={`${consumerBundleId ?? ""}|${providerBundleId ?? ""}`}
        linkedConsumerBundleId={consumerBundleId}
        linkedProviderBundleId={providerBundleId}
      />
      <CheckList />
    </div>
  );
}
