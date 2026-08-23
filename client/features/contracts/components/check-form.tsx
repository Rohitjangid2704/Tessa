"use client";

import { LoaderCircle, TriangleAlert } from "lucide-react";
import { useId, useState, type FormEvent } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useCan } from "@/lib/auth/can";
import { describeStartCheckError } from "../errors";
import { useStartContractCheck } from "../mutations";
import { contractCheckFormSchema } from "../schemas";
import { EMPTY_SIDE_SELECTION, useSideChoice, type SideSelection } from "../use-side-choice";
import { BundleSidePicker } from "./bundle-side-picker";

export type CheckFormProps = {
  linkedConsumerBundleId: string | undefined;
  linkedProviderBundleId: string | undefined;
};

export function CheckForm({ linkedConsumerBundleId, linkedProviderBundleId }: CheckFormProps) {
  const headingId = useId();
  const reasonId = useId();
  const canStart = useCan("contracts.check");
  const [consumerSelection, setConsumerSelection] = useState<SideSelection>(EMPTY_SIDE_SELECTION);
  const [providerSelection, setProviderSelection] = useState<SideSelection>(EMPTY_SIDE_SELECTION);
  const consumer = useSideChoice(consumerSelection, linkedConsumerBundleId);
  const provider = useSideChoice(providerSelection, linkedProviderBundleId);
  const { start, isPending, error, reset } = useStartContractCheck();

  const parsed = contractCheckFormSchema.safeParse({
    consumer_bundle_id: consumer.bundleId ?? "",
    provider_bundle_id: provider.bundleId ?? "",
  });
  const problem = error === null ? null : describeStartCheckError(error);
  const blocker = !canStart
    ? "Starting a check needs the member role."
    : !parsed.success
      ? "Choose a bundle version on both sides."
      : null;
  const sameBundle =
    parsed.success && parsed.data.consumer_bundle_id === parsed.data.provider_bundle_id;

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (blocker !== null || isPending || !parsed.success) {
      return;
    }
    start(parsed.data);
  }

  return (
    <section
      aria-labelledby={headingId}
      data-slot="contract-check-form"
      className="flex flex-col gap-4"
    >
      <div className="flex flex-col gap-1">
        <h2 id={headingId} className="text-base font-semibold">
          Start a contract check
        </h2>
        <p className="max-w-2xl text-sm text-muted-foreground">
          Compare the calls one app says it sends (the consumer) with the interfaces another app
          says it accepts (the provider). The check reads the two bundles only; it never calls
          either app.
        </p>
      </div>
      <form onSubmit={handleSubmit} aria-labelledby={headingId} className="flex flex-col gap-6">
        <div className="grid gap-8 md:grid-cols-2">
          <BundleSidePicker
            slot="consumer"
            title="Consumer"
            description="The app that sends the calls, for example Gracie."
            choice={consumer}
            disabled={isPending}
            fieldError={problem?.fields.consumer_bundle_id}
            onTargetChange={(targetId) => {
              reset();
              setConsumerSelection({ targetId, bundleId: null });
            }}
            onBundleChange={(bundleId) => {
              reset();
              setConsumerSelection({ targetId: consumer.targetId, bundleId });
            }}
          />
          <BundleSidePicker
            slot="provider"
            title="Provider"
            description="The app that accepts the calls, for example hotel operations."
            choice={provider}
            disabled={isPending}
            fieldError={problem?.fields.provider_bundle_id}
            onTargetChange={(targetId) => {
              reset();
              setProviderSelection({ targetId, bundleId: null });
            }}
            onBundleChange={(bundleId) => {
              reset();
              setProviderSelection({ targetId: provider.targetId, bundleId });
            }}
          />
        </div>
        {sameBundle ? (
          <Alert role="status" data-slot="same-bundle-note">
            <TriangleAlert aria-hidden="true" />
            <AlertTitle>Both sides are the same bundle</AlertTitle>
            <AlertDescription>
              <p>The check will find nothing to compare. Pick two different versions.</p>
            </AlertDescription>
          </Alert>
        ) : null}
        {problem === null ? null : (
          <Alert variant="destructive" data-slot="contract-start-error">
            <TriangleAlert aria-hidden="true" />
            <AlertTitle>{problem.title}</AlertTitle>
            <AlertDescription>
              <p>{problem.message}</p>
              {problem.issues.length > 0 ? (
                <ul className="list-disc pl-5">
                  {problem.issues.map((issue) => (
                    <li key={issue}>{issue}</li>
                  ))}
                </ul>
              ) : null}
              {problem.requestId === null ? null : (
                <p className="font-mono text-xs">Request ID: {problem.requestId}</p>
              )}
            </AlertDescription>
          </Alert>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="submit"
            disabled={isPending || blocker !== null}
            aria-describedby={blocker === null ? undefined : reasonId}
            aria-busy={isPending}
          >
            {isPending ? (
              <>
                <LoaderCircle
                  aria-hidden="true"
                  className="animate-spin"
                  data-icon="inline-start"
                />
                Starting the check
              </>
            ) : (
              "Start contract check"
            )}
          </Button>
          {blocker === null ? null : (
            <p id={reasonId} className="text-sm text-muted-foreground">
              {blocker}
            </p>
          )}
        </div>
      </form>
    </section>
  );
}
