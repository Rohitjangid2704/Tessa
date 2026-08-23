"use client";

import { useQuery } from "@tanstack/react-query";
import { TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useId } from "react";
import { DateTime } from "@/components/date-time";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CompletenessBadge, ValidationBadge } from "@/features/bundles/components/bundle-badges";
import { describeApiError } from "@/lib/api/errors";
import { targetOptionsQuery } from "@/features/targets/queries";
import { describeTargetOption } from "@/features/targets/components/target-select";
import { targetRoutes } from "@/lib/routes";
import { useHydrated } from "@/lib/use-hydrated";
import type { BundleSummary, SideChoice } from "../use-side-choice";

export type BundleSidePickerProps = {
  slot: "consumer" | "provider";
  title: string;
  description: string;
  choice: SideChoice;
  onTargetChange: (targetId: string) => void;
  onBundleChange: (bundleId: string) => void;
  fieldError: string | undefined;
  disabled: boolean;
};

export function describeBundleOption(bundle: BundleSummary): string {
  const notes = [
    bundle.completeness_status === "below_bar" ? "below the bar" : null,
    bundle.validation_status === "invalid" ? "did not validate" : null,
  ].filter((note) => note !== null);
  const base = `Version ${bundle.version}, ${bundle.completeness_score} of 100`;
  return notes.length === 0 ? base : `${base}, ${notes.join(", ")}`;
}

function BelowBarWarning({ bundle, targetName }: { bundle: BundleSummary; targetName: string }) {
  return (
    <Alert role="status" data-slot="below-bar-warning">
      <TriangleAlert aria-hidden="true" />
      <AlertTitle>{targetName} version {bundle.version} is below the completeness bar</AlertTitle>
      <AlertDescription>
        <p>
          Its score is {bundle.completeness_score} of 100. A bundle this thin may leave out calls or
          interfaces, so the check can miss differences. Fix the bundle first for a result you can
          rely on.
        </p>
      </AlertDescription>
    </Alert>
  );
}

export function BundleSidePicker({
  slot,
  title,
  description,
  choice,
  onTargetChange,
  onBundleChange,
  fieldError,
  disabled,
}: BundleSidePickerProps) {
  const hydrated = useHydrated();
  const targetTriggerId = useId();
  const bundleTriggerId = useId();
  const errorId = useId();
  const options = useQuery(targetOptionsQuery());
  const targets = hydrated ? (options.data ?? []) : [];
  const selectedTarget = targets.find((target) => target.id === choice.targetId);
  const targetName = selectedTarget?.name ?? "The target";
  const hasNoBundles =
    choice.targetId !== null &&
    !choice.isLoadingBundles &&
    choice.bundlesError === null &&
    choice.bundles.length === 0;

  return (
    <FieldSet data-slot="bundle-side-picker" data-side={slot} disabled={disabled}>
      <FieldLegend>{title}</FieldLegend>
      <FieldDescription>{description}</FieldDescription>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor={targetTriggerId}>Target</FieldLabel>
          <Select value={choice.targetId ?? ""} onValueChange={onTargetChange}>
            <SelectTrigger id={targetTriggerId} className="w-full">
              <SelectValue placeholder="Choose a target">
                {selectedTarget === undefined
                  ? choice.targetId === null
                    ? "Choose a target"
                    : "Selected target"
                  : describeTargetOption({
                      id: selectedTarget.id,
                      name: selectedTarget.name,
                      tier: selectedTarget.tier,
                    })}
              </SelectValue>
            </SelectTrigger>
            <SelectContent position="popper" align="start">
              {targets.map((target) => (
                <SelectItem key={target.id} value={target.id}>
                  {describeTargetOption({ id: target.id, name: target.name, tier: target.tier })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field data-invalid={fieldError === undefined ? undefined : true}>
          <FieldLabel htmlFor={bundleTriggerId}>Bundle version</FieldLabel>
          {choice.targetId === null ? (
            <p className="text-sm text-muted-foreground">
              Choose a target to list its bundle versions.
            </p>
          ) : choice.isLoadingBundles ? (
            <Skeleton className="h-8 w-full" />
          ) : (
            <Select
              value={choice.bundleId ?? ""}
              onValueChange={onBundleChange}
              disabled={choice.bundles.length === 0}
            >
              <SelectTrigger
                id={bundleTriggerId}
                className="w-full"
                aria-invalid={fieldError === undefined ? undefined : true}
                aria-describedby={fieldError === undefined ? undefined : errorId}
              >
                <SelectValue placeholder="Choose a version">
                  {choice.selected === null
                    ? "Choose a version"
                    : describeBundleOption(choice.selected)}
                </SelectValue>
              </SelectTrigger>
              <SelectContent position="popper" align="start">
                {choice.bundles.map((bundle) => (
                  <SelectItem
                    key={bundle.id}
                    value={bundle.id}
                    disabled={bundle.validation_status === "invalid"}
                  >
                    {describeBundleOption(bundle)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {fieldError === undefined ? null : (
            <p id={errorId} role="alert" className="text-xs text-destructive">
              {fieldError}
            </p>
          )}
        </Field>
        {choice.bundlesError === null || choice.bundlesError === undefined ? null : (
          <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-destructive">
            <span>Could not load the bundle versions. {describeApiError(choice.bundlesError)}</span>
            <Button type="button" variant="outline" size="sm" onClick={choice.retryBundles}>
              Try again
            </Button>
          </div>
        )}
        {choice.linkedBundleMissing ? (
          <p role="status" className="text-sm text-muted-foreground">
            The bundle in the link could not be found. Choose a target and a version instead.
          </p>
        ) : null}
        {hasNoBundles && choice.targetId !== null ? (
          <p role="status" className="text-sm text-muted-foreground">
            {targetName} has no bundle yet.{" "}
            <Link
              href={targetRoutes.bundles(choice.targetId)}
              className="underline underline-offset-4"
            >
              Upload one first
            </Link>
          </p>
        ) : null}
        {choice.selected === null ? null : (
          <div data-slot="selected-bundle" className="flex flex-col gap-2 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <ValidationBadge status={choice.selected.validation_status} />
              <CompletenessBadge status={choice.selected.completeness_status} />
              <span className="text-muted-foreground">
                {choice.selected.feature_count} features, uploaded{" "}
                <DateTime value={choice.selected.uploaded_at} />
              </span>
            </div>
            {choice.selected.completeness_status === "below_bar" ? (
              <BelowBarWarning bundle={choice.selected} targetName={targetName} />
            ) : null}
          </div>
        )}
      </FieldGroup>
    </FieldSet>
  );
}
