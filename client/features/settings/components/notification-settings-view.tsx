"use client";

import { useQuery } from "@tanstack/react-query";
import { KeyRound, PlugZap } from "lucide-react";
import { useId } from "react";
import { ErrorState } from "@/components/states/error-state";
import { readRequestId } from "@/components/states/request-id";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { describeApiError } from "@/lib/api/errors";
import type { SettingsRead } from "@/lib/api/types";
import { useCanDo } from "@/lib/auth/can";
import { useHydrated } from "@/lib/use-hydrated";
import {
  NOTIFICATION_SECRET_DEFINITIONS,
  NOTIFICATION_SERVICE_DEFINITIONS,
  SMTP_WORKER_ENV_KEYS,
} from "../notification-definitions";
import { settingsQuery } from "../queries";
import { DirtySectionsProvider, UnsavedChangesGuard } from "../unsaved-changes";
import { NotificationsForm } from "./notifications-form";
import { SecretField } from "./secret-field";
import { ServiceTestRow } from "./service-test";

const SKELETON_SECTIONS = 3;

interface CardProps {
  settings: SettingsRead;
  readOnly: boolean;
}

function NotificationsSkeleton() {
  return (
    <div role="status" aria-busy="true" className="flex flex-col gap-4">
      <span className="sr-only">Loading notification settings</span>
      {Array.from({ length: SKELETON_SECTIONS }, (_, index) => (
        <Skeleton key={index} className="h-40 w-full" />
      ))}
    </div>
  );
}

function ChannelSecretsCard({ settings, readOnly }: CardProps) {
  const titleId = useId();
  return (
    <Card role="region" aria-labelledby={titleId} data-section="notification-secrets">
      <CardHeader>
        <CardTitle id={titleId} role="heading" aria-level={2} className="flex items-center gap-2">
          <KeyRound aria-hidden="true" className="size-4" />
          Channel secrets
        </CardTitle>
        <CardDescription>
          The Slack webhook and the SMTP password are write-only: Tessa stores them encrypted
          and never shows them again. The SMTP host, port, user and sender are not settings here;
          they come from the worker environment (
          {SMTP_WORKER_ENV_KEYS.map((key, index) => (
            <span key={key}>
              {index > 0 ? ", " : ""}
              <code className="font-mono text-xs">{key}</code>
            </span>
          ))}
          ).
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ul aria-label="Notification secrets" className="flex flex-col divide-y">
          {NOTIFICATION_SECRET_DEFINITIONS.map((definition) => (
            <SecretField
              key={definition.name}
              definition={definition}
              status={settings.secrets[definition.name]}
              readOnly={readOnly}
            />
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function ChannelTestsCard({ readOnly }: { readOnly: boolean }) {
  const titleId = useId();
  return (
    <Card role="region" aria-labelledby={titleId} data-section="notification-tests">
      <CardHeader>
        <CardTitle id={titleId} role="heading" aria-level={2} className="flex items-center gap-2">
          <PlugZap aria-hidden="true" className="size-4" />
          Connectivity tests
        </CardTitle>
        <CardDescription>
          Check each channel with what is stored now. They never send or show a secret.
          {readOnly ? " Only admins can run them." : null}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ul aria-label="Notification channel connectivity" className="flex flex-col divide-y">
          {NOTIFICATION_SERVICE_DEFINITIONS.map((definition) => (
            <ServiceTestRow key={definition.service} definition={definition} readOnly={readOnly} />
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

export function NotificationSettingsView() {
  const hydrated = useHydrated();
  const settings = useQuery(settingsQuery());
  const writeAccess = useCanDo("settings.write");
  const secretsAccess = useCanDo("settings.secrets");
  const testAccess = useCanDo("settings.test_service");
  const rolePending = writeAccess.isPending || secretsAccess.isPending || testAccess.isPending;

  if (!hydrated || settings.isPending || rolePending) {
    return <NotificationsSkeleton />;
  }

  if (settings.isError) {
    return (
      <ErrorState
        title="Could not load the notification settings"
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
            You have read-only access. Admins can change notification settings, replace the Slack
            webhook and the SMTP password, and run the channel tests.
          </p>
        ) : null}
        <NotificationsForm settings={settings.data} readOnly={readOnly} />
        <ChannelSecretsCard settings={settings.data} readOnly={!secretsAccess.allowed} />
        <ChannelTestsCard readOnly={!testAccess.allowed} />
      </div>
    </DirtySectionsProvider>
  );
}
