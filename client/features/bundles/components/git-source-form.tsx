"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery } from "@tanstack/react-query";
import { LoaderCircle, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useId, useState } from "react";
import { Controller, useForm, useFormState } from "react-hook-form";
import { toast } from "sonner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { environmentQuery } from "@/features/environment/queries";
import { describeApiError } from "@/lib/api/errors";
import { applyApiFieldErrors } from "@/lib/api/form-errors";
import type { BundleSource } from "@/lib/api/types";
import { targetRoutes } from "@/lib/routes";
import { usePutBundleSource } from "../bundle-source-mutations";
import {
  BUNDLE_SOURCE_FIELDS,
  bundleSourceFormValues,
  bundleSourceSchema,
  DEFAULT_GIT_PATH,
  toBundleSourceSet,
  type BundleSourceFormValues,
} from "../bundle-source-schemas";
import { credentialOptions } from "../credential-options";

export type GitSourceFormProps = {
  targetId: string;
  source: BundleSource | null;
  readOnlyReason: string | null;
};

export function GitSourceForm({ targetId, source, readOnlyReason }: GitSourceFormProps) {
  const urlId = useId();
  const branchId = useId();
  const pathId = useId();
  const credentialId = useId();
  const credentialHintId = useId();
  const environment = useQuery(environmentQuery(targetId));
  const save = usePutBundleSource(targetId);
  const form = useForm<BundleSourceFormValues>({
    resolver: zodResolver(bundleSourceSchema),
    values: bundleSourceFormValues(source),
  });
  const { errors, isDirty } = useFormState({ control: form.control });
  const [formError, setFormError] = useState<string | null>(null);
  const locked = readOnlyReason !== null || save.isPending;
  const options = credentialOptions(environment.data?.items ?? [], source?.credential_name ?? "");
  const noCredentials = environment.isSuccess && options.length === 0;

  function submit(values: BundleSourceFormValues): void {
    setFormError(null);
    save.mutate(toBundleSourceSet(values), {
      onSuccess: () => toast.success("Git source saved"),
      onError: (error) =>
        setFormError(applyApiFieldErrors(error, form.setError, BUNDLE_SOURCE_FIELDS)),
    });
  }

  return (
    <form
      aria-label="Git source"
      noValidate
      data-slot="git-source-form"
      onSubmit={(event) => void form.handleSubmit(submit)(event)}
      className="max-w-2xl"
    >
      <FieldGroup>
        {formError === null ? null : (
          <Alert variant="destructive">
            <TriangleAlert aria-hidden="true" />
            <AlertDescription>{formError}</AlertDescription>
          </Alert>
        )}
        <Field data-invalid={errors.git_url ? true : undefined}>
          <FieldLabel htmlFor={urlId}>Repository URL</FieldLabel>
          <Input
            id={urlId}
            autoComplete="off"
            spellCheck={false}
            inputMode="url"
            disabled={locked}
            placeholder="https://github.com/your-org/your-repo.git"
            aria-invalid={errors.git_url ? true : undefined}
            {...form.register("git_url")}
          />
          <FieldDescription>
            An https address without a username or password. The server only accepts hosts on its
            allow-list.
          </FieldDescription>
          <FieldError errors={[errors.git_url]} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field data-invalid={errors.branch ? true : undefined}>
            <FieldLabel htmlFor={branchId}>Branch</FieldLabel>
            <Input
              id={branchId}
              autoComplete="off"
              spellCheck={false}
              disabled={locked}
              aria-invalid={errors.branch ? true : undefined}
              {...form.register("branch")}
            />
            <FieldError errors={[errors.branch]} />
          </Field>
          <Field data-invalid={errors.path ? true : undefined}>
            <FieldLabel htmlFor={pathId}>Folder</FieldLabel>
            <Input
              id={pathId}
              autoComplete="off"
              spellCheck={false}
              disabled={locked}
              placeholder={DEFAULT_GIT_PATH}
              aria-invalid={errors.path ? true : undefined}
              {...form.register("path")}
            />
            <FieldError errors={[errors.path]} />
          </Field>
        </div>
        <Field data-invalid={errors.credential_name ? true : undefined}>
          <FieldLabel htmlFor={credentialId}>Credential</FieldLabel>
          <Controller
            control={form.control}
            name="credential_name"
            render={({ field }) => (
              <Select
                value={field.value}
                onValueChange={field.onChange}
                disabled={locked || options.length === 0}
              >
                <SelectTrigger
                  id={credentialId}
                  className="w-full"
                  aria-invalid={errors.credential_name ? true : undefined}
                  aria-describedby={credentialHintId}
                >
                  <SelectValue
                    placeholder={
                      environment.isPending
                        ? "Loading the environment variables"
                        : "Choose a token or password variable"
                    }
                  />
                </SelectTrigger>
                <SelectContent position="popper" align="start">
                  {options.map((option) => (
                    <SelectItem key={option.name} value={option.name}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          />
          <FieldDescription id={credentialHintId}>
            Only the variable name is stored. Its value is write-only and is set on the{" "}
            <Link
              href={targetRoutes.environment(targetId)}
              className="underline underline-offset-4"
            >
              Environment page
            </Link>
            .
          </FieldDescription>
          {environment.isError ? (
            <Alert variant="destructive">
              <TriangleAlert aria-hidden="true" />
              <AlertDescription className="flex flex-wrap items-center gap-2">
                Could not load the environment variables: {describeApiError(environment.error)}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void environment.refetch()}
                >
                  Try again
                </Button>
              </AlertDescription>
            </Alert>
          ) : null}
          {noCredentials ? (
            <p role="status" className="text-sm text-muted-foreground">
              This target has no token or password variable yet. Add one on the Environment page
              first.
            </p>
          ) : null}
          <FieldError errors={[errors.credential_name]} />
        </Field>
        {readOnlyReason === null ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" disabled={!isDirty || save.isPending} aria-busy={save.isPending}>
              {save.isPending ? (
                <LoaderCircle
                  aria-hidden="true"
                  data-icon="inline-start"
                  className="animate-spin"
                />
              ) : null}
              {save.isPending ? "Saving" : "Save git source"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={!isDirty || save.isPending}
              onClick={() => {
                form.reset();
                setFormError(null);
              }}
            >
              Discard changes
            </Button>
          </div>
        ) : (
          <p data-slot="read-only-notice" className="text-sm text-muted-foreground">
            {readOnlyReason}
          </p>
        )}
      </FieldGroup>
    </form>
  );
}
