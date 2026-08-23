"use client";

import { useQuery } from "@tanstack/react-query";
import { KeyRound, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useId, useState } from "react";
import { EmptyState } from "@/components/states/empty-state";
import { ErrorState } from "@/components/states/error-state";
import { readRequestId } from "@/components/states/request-id";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useTarget } from "@/features/targets/queries";
import { describeApiError } from "@/lib/api/errors";
import { useCanDo } from "@/lib/auth/can";
import { targetRoutes } from "@/lib/routes";
import { useHydrated } from "@/lib/use-hydrated";
import { describeSaveFailure, type SaveFailure } from "../errors";
import { useSaveEnvironment } from "../mutations";
import { environmentQuery } from "../queries";
import type { EnvironmentList, EnvironmentPatch, EnvironmentVariable } from "../types";
import { useInterfaceKinds } from "../use-interface-kinds";
import { EnvironmentForm, type EnvironmentReadOnlyReason } from "./environment-form";
import { HealthPanel } from "./health-panel";

export interface EnvironmentViewProps {
  targetId: string;
}

export function environmentRevision(items: readonly EnvironmentVariable[]): string {
  return items
    .map((item) =>
      [item.name, item.has_value, item.stale, item.value ?? "", item.last_set_at ?? ""].join("|"),
    )
    .join("\n");
}

function missingRequiredNames(list: EnvironmentList): string[] {
  return list.items
    .filter((item) => item.required && !item.stale && !item.has_value)
    .map((item) => item.name);
}

export function describeSaved(patch: Pick<EnvironmentPatch, "set" | "clear">): string {
  const setCount = Object.keys(patch.set ?? {}).length;
  const clearCount = (patch.clear ?? []).length;
  const parts = [
    setCount > 0 ? `${setCount} ${setCount === 1 ? "value" : "values"} set` : null,
    clearCount > 0 ? `${clearCount} ${clearCount === 1 ? "value" : "values"} cleared` : null,
  ].filter((part): part is string => part !== null);
  return `Saved: ${parts.join(", ")}.`;
}

function EnvironmentSkeleton() {
  return (
    <div role="status" aria-busy="true" className="flex flex-col gap-4">
      <span className="sr-only">Loading the environment</span>
      <Skeleton className="h-6 w-48" />
      <Skeleton className="h-20 w-full max-w-3xl" />
      <Skeleton className="h-20 w-full max-w-3xl" />
      <Skeleton className="h-20 w-full max-w-3xl" />
    </div>
  );
}

function MissingRequiredBanner({ list }: { list: EnvironmentList }) {
  if (list.missing_required === 0) {
    return null;
  }
  const names = missingRequiredNames(list);
  return (
    <Alert data-slot="missing-required-banner" role="status">
      <TriangleAlert aria-hidden="true" />
      <AlertTitle>
        {list.missing_required === 1
          ? "1 required variable has no value"
          : `${list.missing_required} required variables have no value`}
      </AlertTitle>
      <AlertDescription>
        {names.length > 0 ? (
          <p>
            Set <span className="font-mono">{names.join(", ")}</span> before running a plan.
          </p>
        ) : (
          <p>Set them before running a plan.</p>
        )}
      </AlertDescription>
    </Alert>
  );
}

export function EnvironmentView({ targetId }: EnvironmentViewProps) {
  const variablesHeadingId = useId();
  const healthHeadingId = useId();
  const hydrated = useHydrated();
  const target = useTarget(targetId);
  const environment = useQuery(environmentQuery(targetId));
  const interfaceKinds = useInterfaceKinds(targetId);
  const writeAccess = useCanDo("environment.write");
  const healthAccess = useCanDo("environment.health_check");
  const save = useSaveEnvironment(targetId);
  const [failure, setFailure] = useState<SaveFailure | null>(null);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);

  if (
    !hydrated ||
    environment.isPending ||
    target.isPending ||
    writeAccess.isPending ||
    healthAccess.isPending
  ) {
    return <EnvironmentSkeleton />;
  }

  if (environment.isError) {
    return (
      <ErrorState
        title="Could not load the environment"
        description={describeApiError(environment.error)}
        requestId={readRequestId(environment.error)}
        onRetry={() => void environment.refetch()}
      />
    );
  }

  const list = environment.data;
  const archived = target.data?.archived_at != null;
  const readOnlyReason: EnvironmentReadOnlyReason = archived
    ? "archived"
    : writeAccess.allowed
      ? null
      : "role";
  const healthReadOnlyReason: EnvironmentReadOnlyReason = archived
    ? "archived"
    : healthAccess.allowed
      ? null
      : "role";

  function handleSave(patch: EnvironmentPatch): void {
    setFailure(null);
    setSavedMessage(null);
    save.mutate(patch, {
      onSuccess: () => setSavedMessage(describeSaved(patch)),
      onError: (error) => setFailure(describeSaveFailure(error)),
      onSettled: () => save.reset(),
    });
  }

  return (
    <div className="flex flex-col gap-10">
      <section aria-labelledby={variablesHeadingId} className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h2 id={variablesHeadingId} className="text-lg font-semibold">
            Variables
          </h2>
          <p className="max-w-2xl text-sm text-muted-foreground">
            The values the bundle&apos;s env.template asks for. Secrets are write-only: they are
            stored encrypted and never shown again.
          </p>
        </div>
        <MissingRequiredBanner list={list} />
        {list.items.length === 0 ? (
          <EmptyState
            title="No variables yet"
            description="Variables come from the env.template of a valid bundle. Upload one and they appear here."
            icon={KeyRound}
            action={
              <Button asChild>
                <Link href={targetRoutes.bundles(targetId)}>Upload a bundle</Link>
              </Button>
            }
          />
        ) : (
          <EnvironmentForm
            key={environmentRevision(list.items)}
            variables={list.items}
            interfaceKinds={interfaceKinds}
            readOnlyReason={readOnlyReason}
            isSaving={save.isPending}
            failure={failure}
            savedMessage={savedMessage}
            onSave={handleSave}
          />
        )}
      </section>
      <section aria-labelledby={healthHeadingId} className="flex flex-col gap-4">
        <h2 id={healthHeadingId} className="text-lg font-semibold">
          Health checks
        </h2>
        <HealthPanel targetId={targetId} readOnlyReason={healthReadOnlyReason} />
      </section>
    </div>
  );
}
