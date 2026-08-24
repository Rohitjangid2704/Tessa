"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { ArrowRight, Check, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Controller, useForm, useFormState, useWatch } from "react-hook-form";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { ConnectPanelSection } from "@/features/claude-code/components/connect-panel-section";
import { DiscoveryPromptPanel } from "@/features/prompts/components/discovery-prompt-panel";
import { applyApiFieldErrors } from "@/lib/api/form-errors";
import { useCanDo, useCurrentRole } from "@/lib/auth/can";
import { useHydrated } from "@/lib/use-hydrated";
import { targetRoutes } from "@/lib/routes";
import { APP_KIND_LABELS, APP_KINDS } from "../app-kinds";
import { rememberTarget } from "../current-target";
import { useCreateTarget } from "../mutations";
import { TARGET_NAME_MAX_LENGTH, targetCreateSchema, type TargetCreateInput } from "../schemas";
import type { Target } from "../types";
import { TargetTierBadge } from "./target-tier-badge";

const FORM_FIELDS = ["name", "app_kind"] as const;

function StepIndicator({ step }: { step: 1 | 2 }) {
  const steps = ["Name and app kind", "Discovery prompt"];
  return (
    <ol aria-label="Progress" className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
      {steps.map((label, index) => {
        const position = index + 1;
        const done = position < step;
        const current = position === step;
        return (
          <li
            key={label}
            aria-current={current ? "step" : undefined}
            className={current ? "font-medium" : "text-muted-foreground"}
          >
            <span className="flex items-center gap-2">
              <span
                aria-hidden="true"
                className="flex size-6 items-center justify-center rounded-full border text-xs"
              >
                {done ? <Check className="size-3.5" /> : position}
              </span>
              <span>
                <span className="sr-only">Step {position}: </span>
                {label}
                {done ? <span className="sr-only"> (done)</span> : null}
              </span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function CreateTargetForm({ onCreated }: { onCreated: (target: Target) => void }) {
  const createTarget = useCreateTarget();
  const form = useForm<TargetCreateInput>({
    resolver: zodResolver(targetCreateSchema),
    defaultValues: { name: "" },
  });
  const { errors } = useFormState({ control: form.control });
  const appKind = useWatch({ control: form.control, name: "app_kind" });
  const [formError, setFormError] = useState<string | null>(null);

  function submit(values: TargetCreateInput): void {
    setFormError(null);
    createTarget.mutate(
      { name: values.name, app_kind: values.app_kind },
      {
        onSuccess: (target) => {
          rememberTarget(target.id);
          onCreated(target);
        },
        onError: (error) => setFormError(applyApiFieldErrors(error, form.setError, FORM_FIELDS)),
      },
    );
  }

  return (
    <Card data-slot="create-target-form">
      <CardHeader>
        <CardTitle role="heading" aria-level={2}>
          Name and app kind
        </CardTitle>
        <CardDescription>
          The app kind decides which hints the Discovery prompt offers in the next step.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form aria-label="New target" noValidate onSubmit={form.handleSubmit(submit)}>
          <FieldGroup>
            {formError !== null ? (
              <Alert variant="destructive">
                <TriangleAlert aria-hidden="true" />
                <AlertTitle>Could not create the target</AlertTitle>
                <AlertDescription>{formError}</AlertDescription>
              </Alert>
            ) : null}
            <Field data-invalid={errors.name ? true : undefined}>
              <FieldLabel htmlFor="target-name">Name</FieldLabel>
              <Input
                id="target-name"
                autoComplete="off"
                aria-invalid={errors.name ? true : undefined}
                aria-describedby="target-name-help"
                {...form.register("name")}
              />
              <FieldDescription id="target-name-help">
                Shown in lists and in the prompt. Up to {TARGET_NAME_MAX_LENGTH} characters.
              </FieldDescription>
              <FieldError errors={[errors.name]} />
            </Field>
            <Field data-invalid={errors.app_kind ? true : undefined}>
              <FieldLabel htmlFor="target-app-kind">App kind</FieldLabel>
              <Controller
                control={form.control}
                name="app_kind"
                render={({ field }) => (
                  <Select value={field.value ?? ""} onValueChange={field.onChange}>
                    <SelectTrigger
                      id="target-app-kind"
                      ref={field.ref}
                      onBlur={field.onBlur}
                      aria-invalid={errors.app_kind ? true : undefined}
                      className="w-full sm:w-72"
                    >
                      <SelectValue placeholder="Choose an app kind" />
                    </SelectTrigger>
                    <SelectContent position="popper" align="start">
                      {APP_KINDS.map((kind) => (
                        <SelectItem key={kind} value={kind}>
                          {APP_KIND_LABELS[kind]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
              <FieldDescription>
                {appKind === undefined
                  ? "Targets start as QA targets; production is set by an admin."
                  : `${APP_KIND_LABELS[appKind]} target, QA tier.`}
              </FieldDescription>
              <FieldError errors={[errors.app_kind]} />
            </Field>
            <div>
              <Button type="submit" disabled={createTarget.isPending}>
                {createTarget.isPending ? "Creating" : "Create target"}
              </Button>
            </div>
          </FieldGroup>
        </form>
      </CardContent>
    </Card>
  );
}

function CreatedSummary({ target }: { target: Target }) {
  return (
    <Card data-slot="created-target-summary" size="sm">
      <CardContent className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <p className="flex items-center gap-2 text-sm font-medium">
          <Check aria-hidden="true" className="size-4" />
          Target created
        </p>
        <dl className="flex flex-wrap items-center gap-x-6 gap-y-1 text-sm">
          <div className="flex items-center gap-2">
            <dt className="text-muted-foreground">Name</dt>
            <dd className="font-medium">{target.name}</dd>
          </div>
          <div className="flex items-center gap-2">
            <dt className="text-muted-foreground">App kind</dt>
            <dd>{APP_KIND_LABELS[target.app_kind]}</dd>
          </div>
          <div className="flex items-center gap-2">
            <dt className="text-muted-foreground">Tier</dt>
            <dd>
              <TargetTierBadge tier={target.tier} />
            </dd>
          </div>
        </dl>
      </CardContent>
    </Card>
  );
}

export function NewTargetWizard() {
  const hydrated = useHydrated();
  const { role } = useCurrentRole();
  const { allowed, isPending } = useCanDo("targets.create");
  const [created, setCreated] = useState<Target | null>(null);

  if (!hydrated || isPending) {
    return (
      <div role="status" aria-busy="true" className="flex flex-col gap-4">
        <span className="sr-only">Checking your role</span>
        <Skeleton className="h-6 w-64" />
        <Skeleton className="h-64 w-full max-w-2xl" />
      </div>
    );
  }

  if (!allowed) {
    return (
      <Alert>
        <TriangleAlert aria-hidden="true" />
        <AlertTitle>You cannot create targets</AlertTitle>
        <AlertDescription>
          <p>
            Creating a target needs the member or admin role, and your role is {role ?? "unknown"}.
            Ask a member to create it, or open an existing target from the{" "}
            <Link href={targetRoutes.list()} className="underline underline-offset-3">
              targets list
            </Link>
            .
          </p>
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <StepIndicator step={created === null ? 1 : 2} />
      {created === null ? (
        <CreateTargetForm onCreated={setCreated} />
      ) : (
        <>
          <CreatedSummary target={created} />
          <DiscoveryPromptPanel target={created} />
          <ConnectPanelSection />
          <div className="flex flex-wrap items-center gap-3">
            <Button asChild>
              <Link href={targetRoutes.bundles(created.id)}>
                Go to bundle upload
                <ArrowRight aria-hidden="true" data-icon="inline-end" />
              </Link>
            </Button>
            <Button asChild variant="ghost">
              <Link href={targetRoutes.detail(created.id)}>Open the target page</Link>
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
