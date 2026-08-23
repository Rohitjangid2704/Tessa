"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { GitPullRequest, LoaderCircle, TriangleAlert } from "lucide-react";
import { useId, useState } from "react";
import { useForm, useFormState } from "react-hook-form";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import type { BundleSource } from "@/lib/api/types";
import { useCanDo } from "@/lib/auth/can";
import { usePullBundle } from "../bundle-source-mutations";
import {
  pullRefSchema,
  toBundleImportCreate,
  type PullRefFormValues,
} from "../bundle-source-schemas";
import { describePullError } from "../pull-errors";

export const PULL_READ_ONLY_REASON = "Viewers can read the git source but cannot pull from it.";
export const PULL_NO_SOURCE_REASON = "Save the git source first, then pull.";

export type PullFromGitButtonProps = {
  targetId: string;
  source: BundleSource | null | undefined;
  variant?: "default" | "outline";
};

function SourceSummary({ source }: { source: BundleSource }) {
  return (
    <dl
      data-slot="pull-source-summary"
      className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-lg border p-3 text-sm"
    >
      <dt className="text-muted-foreground">Repository</dt>
      <dd className="font-mono text-xs break-all">{source.git_url}</dd>
      <dt className="text-muted-foreground">Branch</dt>
      <dd className="font-mono text-xs">{source.branch}</dd>
      <dt className="text-muted-foreground">Folder</dt>
      <dd className="font-mono text-xs">{source.path}</dd>
      <dt className="text-muted-foreground">Credential</dt>
      <dd className="font-mono text-xs">{source.credential_name}</dd>
    </dl>
  );
}

export function PullFromGitButton({
  targetId,
  source,
  variant = "default",
}: PullFromGitButtonProps) {
  const reasonId = useId();
  const refInputId = useId();
  const [open, setOpen] = useState(false);
  const pullAccess = useCanDo("bundles.source_pull");
  const pull = usePullBundle(targetId);
  const form = useForm<PullRefFormValues>({
    resolver: zodResolver(pullRefSchema),
    defaultValues: { ref: "" },
  });
  const { errors } = useFormState({ control: form.control });
  const savedSource = source ?? null;
  const reason = pullAccess.isPending
    ? null
    : !pullAccess.allowed
      ? PULL_READ_ONLY_REASON
      : savedSource === null
        ? PULL_NO_SOURCE_REASON
        : null;
  const problem = pull.error === null ? null : describePullError(pull.error);

  function handleOpenChange(next: boolean): void {
    if (!next && pull.isPending) {
      return;
    }
    setOpen(next);
    if (!next) {
      pull.reset();
      form.reset();
    }
  }

  function submit(values: PullRefFormValues): void {
    pull.start(toBundleImportCreate(values));
  }

  return (
    <div data-slot="pull-from-git" className="flex flex-col items-start gap-1.5">
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogTrigger asChild>
          <Button
            type="button"
            variant={variant}
            disabled={pullAccess.isPending || reason !== null}
            aria-describedby={reason === null ? undefined : reasonId}
          >
            <GitPullRequest aria-hidden="true" data-icon="inline-start" />
            Pull from git
          </Button>
        </DialogTrigger>
        {savedSource === null ? null : (
          <DialogContent className="sm:max-w-lg">
            <form
              aria-label="Pull from git"
              noValidate
              onSubmit={(event) => void form.handleSubmit(submit)(event)}
              className="grid gap-4"
            >
              <DialogHeader>
                <DialogTitle>Pull from git</DialogTitle>
                <DialogDescription>
                  Tessa clones the repository once, reads the {savedSource.path} folder as a new
                  bundle version and deletes the clone. It never keeps your repository.
                </DialogDescription>
              </DialogHeader>
              <SourceSummary source={savedSource} />
              <Field data-invalid={errors.ref ? true : undefined}>
                <FieldLabel htmlFor={refInputId}>Branch, tag or commit (optional)</FieldLabel>
                <Input
                  id={refInputId}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={pull.isPending}
                  placeholder={savedSource.branch}
                  aria-invalid={errors.ref ? true : undefined}
                  {...form.register("ref")}
                />
                <FieldDescription>
                  Leave it empty to pull the saved branch, {savedSource.branch}.
                </FieldDescription>
                <FieldError errors={[errors.ref]} />
              </Field>
              {problem === null ? null : (
                <Alert variant="destructive" data-slot="pull-problem" data-kind={problem.kind}>
                  <TriangleAlert aria-hidden="true" />
                  <AlertTitle>{problem.title}</AlertTitle>
                  <AlertDescription>
                    <p>{problem.message}</p>
                    {problem.details.length === 0 ? null : (
                      <ul className="mt-1 flex list-disc flex-col gap-0.5 pl-4">
                        {problem.details.map((detail, index) => (
                          <li key={`${detail.code}-${index}`}>
                            <code className="font-mono text-xs">{detail.code}</code>:{" "}
                            {detail.message}
                          </li>
                        ))}
                      </ul>
                    )}
                    {problem.requestId === null ? null : (
                      <p className="mt-1 font-mono text-xs">Request ID: {problem.requestId}</p>
                    )}
                  </AlertDescription>
                </Alert>
              )}
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  disabled={pull.isPending}
                  onClick={() => handleOpenChange(false)}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={pull.isPending} aria-busy={pull.isPending}>
                  {pull.isPending ? (
                    <LoaderCircle
                      aria-hidden="true"
                      data-icon="inline-start"
                      className="animate-spin"
                    />
                  ) : null}
                  {pull.isPending ? "Starting the pull" : problem === null ? "Pull" : "Try again"}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        )}
      </Dialog>
      {reason === null ? null : (
        <p id={reasonId} className="text-sm text-muted-foreground">
          {reason}
        </p>
      )}
    </div>
  );
}
