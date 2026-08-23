"use client";

import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Minus, Pencil, Plus } from "lucide-react";
import { useId, useState } from "react";
import { JsonDiff, type JsonRecord } from "@/components/json-diff";
import { ErrorState } from "@/components/states/error-state";
import { readRequestId } from "@/components/states/request-id";
import { StatusBadge } from "@/components/status/status-badge";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { describeApiError } from "@/lib/api/errors";
import type { components } from "@/lib/api/schema";
import { pluralize } from "../format";
import { bundleDiffQuery, bundleVersionsOptions } from "../queries";

type BundleDiff = components["schemas"]["BundleDiff"];
type BundleChange = components["schemas"]["BundleChange"];
type BundleDiffFeature = components["schemas"]["BundleDiffFeature"];
type Bundle = components["schemas"]["Bundle"];

export const DEFAULT_AGAINST = "default";

function ChangeBadge({ change }: { change: BundleChange }) {
  if (change === "added") {
    return <StatusBadge tone="verdict-pass" label="Added" icon={Plus} />;
  }
  if (change === "removed") {
    return <StatusBadge tone="verdict-fail" label="Removed" icon={Minus} />;
  }
  return <StatusBadge tone="verdict-flaky" label="Changed" icon={Pencil} />;
}

export function countChanges(features: readonly BundleDiffFeature[]) {
  return {
    added: features.filter((feature) => feature.change === "added").length,
    removed: features.filter((feature) => feature.change === "removed").length,
    changed: features.filter((feature) => feature.change === "changed").length,
  };
}

function FeatureChange({ feature }: { feature: BundleDiffFeature }) {
  const snapshot: JsonRecord | null | undefined =
    feature.change === "removed" ? feature.before : feature.after;
  return (
    <li
      data-feature={feature.feature_id}
      data-change={feature.change}
      className="flex flex-col gap-3 rounded-xl border p-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <ChangeBadge change={feature.change} />
        <code className="font-mono text-sm">{feature.feature_id}</code>
        {feature.change === "changed" ? (
          <span className="text-xs text-muted-foreground">
            {pluralize(feature.fields_changed.length, "field")} changed
          </span>
        ) : null}
      </div>
      {feature.change === "changed" ? (
        <JsonDiff before={feature.before} after={feature.after} fields={feature.fields_changed} />
      ) : (
        <details className="text-sm">
          <summary className="cursor-pointer rounded-md py-1 font-medium focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none">
            {feature.change === "added" ? "Show the added feature" : "Show the removed feature"}
          </summary>
          <pre className="mt-2 rounded-md bg-muted px-2 py-1.5 font-mono text-xs break-words whitespace-pre-wrap">
            {JSON.stringify(snapshot ?? {}, null, 2)}
          </pre>
        </details>
      )}
    </li>
  );
}

function DiffBody({ diff }: { diff: BundleDiff }) {
  const counts = countChanges(diff.features);
  const nothing = diff.features.length === 0 && diff.sections.length === 0;

  return (
    <div className="flex flex-col gap-4">
      <p data-slot="diff-summary" className="text-sm">
        {diff.summary}
      </p>
      {nothing ? null : (
        <p className="text-sm text-muted-foreground">
          Features: {counts.added} added, {counts.removed} removed, {counts.changed} changed.
        </p>
      )}
      {diff.features.length === 0 ? null : (
        <ul aria-label="Feature changes" className="flex flex-col gap-3">
          {diff.features.map((feature) => (
            <FeatureChange key={feature.feature_id} feature={feature} />
          ))}
        </ul>
      )}
      {diff.sections.length === 0 ? null : (
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">Changed sections and files</h3>
          <ul aria-label="Section changes" className="flex flex-col gap-1.5">
            {diff.sections.map((section) => (
              <li
                key={section.section}
                data-section={section.section}
                className="flex flex-wrap items-center gap-2 text-sm"
              >
                <ChangeBadge change={section.change} />
                <code className="font-mono text-xs">{section.section}</code>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export interface BundleDiffViewProps {
  bundle: Pick<Bundle, "id" | "target_id" | "version" | "validation_status">;
  initialAgainst?: string | null;
}

export function BundleDiffView({ bundle, initialAgainst = null }: BundleDiffViewProps) {
  const selectId = useId();
  const headingId = useId();
  const [selected, setSelected] = useState(initialAgainst ?? DEFAULT_AGAINST);
  const against = selected === DEFAULT_AGAINST ? null : selected;
  const versions = useInfiniteQuery(bundleVersionsOptions(bundle.target_id));
  const diff = useQuery(bundleDiffQuery(bundle.id, against));
  const others = (versions.data?.items ?? []).filter((item) => item.id !== bundle.id);

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h2 id={headingId} className="text-lg font-semibold">
            Changes
          </h2>
          <p className="text-sm text-muted-foreground">
            Version {bundle.version} compared with another version of this target.
          </p>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={selectId}>Compare with</Label>
          <Select value={selected} onValueChange={setSelected}>
            <SelectTrigger id={selectId} className="min-w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper">
              <SelectItem value={DEFAULT_AGAINST}>Previous valid version</SelectItem>
              {others.map((item) => (
                <SelectItem key={item.id} value={item.id}>
                  Version {item.version}
                  {item.validation_status === "invalid" ? " (invalid)" : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      {diff.isPending ? (
        <div role="status" aria-busy="true" className="flex flex-col gap-2">
          <span className="sr-only">Loading the diff</span>
          <Skeleton className="h-4 w-72 max-w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : diff.isError ? (
        <ErrorState
          title="Could not load the diff"
          description={describeApiError(diff.error)}
          requestId={readRequestId(diff.error)}
          onRetry={() => void diff.refetch()}
          className="py-8"
        />
      ) : (
        <DiffBody diff={diff.data} />
      )}
    </section>
  );
}
