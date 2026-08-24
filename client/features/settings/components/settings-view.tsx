"use client";

import { useQuery } from "@tanstack/react-query";
import { ErrorState } from "@/components/states/error-state";
import { readRequestId } from "@/components/states/request-id";
import { Skeleton } from "@/components/ui/skeleton";
import { describeApiError } from "@/lib/api/errors";
import { useCanDo } from "@/lib/auth/can";
import { useHydrated } from "@/lib/use-hydrated";
import { settingsQuery } from "../queries";
import { DirtySectionsProvider, UnsavedChangesGuard } from "../unsaved-changes";
import { BudgetsForm } from "./budgets-form";
import { EndpointsForm } from "./endpoints-form";
import { ModelRoleTable } from "./model-role-table";
import { SecretsCard } from "./secrets-card";
import { ServiceTestCard } from "./service-test";
import { ThresholdForm } from "./threshold-form";

const SKELETON_SECTIONS = 4;

function SettingsSkeleton() {
  return (
    <div role="status" aria-busy="true" className="flex flex-col gap-4">
      <span className="sr-only">Loading settings</span>
      {Array.from({ length: SKELETON_SECTIONS }, (_, index) => (
        <Skeleton key={index} className="h-40 w-full" />
      ))}
    </div>
  );
}

export function SettingsView() {
  const hydrated = useHydrated();
  const settings = useQuery(settingsQuery());
  const writeAccess = useCanDo("settings.write");
  const secretsAccess = useCanDo("settings.secrets");
  const testAccess = useCanDo("settings.test_service");
  const rolePending = writeAccess.isPending || secretsAccess.isPending || testAccess.isPending;

  if (!hydrated || settings.isPending || rolePending) {
    return <SettingsSkeleton />;
  }

  if (settings.isError) {
    return (
      <ErrorState
        title="Could not load the settings"
        description={describeApiError(settings.error)}
        requestId={readRequestId(settings.error)}
        retryLabel={settings.isFetching ? "Retrying" : "Retry"}
        onRetry={() => void settings.refetch()}
      />
    );
  }

  const readOnly = !writeAccess.allowed;

  return (
    <DirtySectionsProvider>
      <UnsavedChangesGuard />
      <div className="flex flex-col gap-4">
        {readOnly ? (
          <p
            data-slot="read-only-notice"
            className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground"
          >
            You have read-only access. Admins can change settings, replace keys and run connectivity
            tests; you can still see every value and which keys are set.
          </p>
        ) : null}
        <ModelRoleTable settings={settings.data} readOnly={readOnly} />
        <ThresholdForm settings={settings.data} readOnly={readOnly} />
        <EndpointsForm settings={settings.data} readOnly={readOnly} />
        <BudgetsForm settings={settings.data} readOnly={readOnly} />
        <SecretsCard settings={settings.data} readOnly={!secretsAccess.allowed} />
        <ServiceTestCard readOnly={!testAccess.allowed} />
      </div>
    </DirtySectionsProvider>
  );
}
