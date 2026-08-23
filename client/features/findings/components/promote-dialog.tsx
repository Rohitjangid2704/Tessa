"use client";

import { ExternalLink, LoaderCircle, Rocket } from "lucide-react";
import Link from "next/link";
import { useId, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { RequiresPermission } from "@/components/requires-permission";
import { readRequestId } from "@/components/states/request-id";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useIdempotencyKey } from "@/lib/api/idempotency";
import type { Finding } from "@/lib/api/types";
import { scenarioHref } from "@/lib/routes";
import { describePromoteError, usePromoteFinding } from "../detail-mutations";
import { PROMOTE_TITLE_MAX_LENGTH, promoteTitleSchema } from "../detail-schemas";

export interface PromoteDialogProps {
  finding: Pick<Finding, "id" | "title" | "promoted_scenario_id">;
}

type PromoteMutation = ReturnType<typeof usePromoteFinding>;

interface PromoteFormProps {
  findingTitle: string;
  promote: PromoteMutation;
  onTitleEdited: () => void;
  onSubmit: (title: string | null) => void;
  onClose: () => void;
}

function PromoteForm({ findingTitle, promote, onTitleEdited, onSubmit, onClose }: PromoteFormProps) {
  const titleId = useId();
  const hintId = useId();
  const errorId = useId();
  const [title, setTitle] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);

  const serverMessage = promote.isError ? describePromoteError(promote.error) : null;
  const requestId = promote.isError ? readRequestId(promote.error) : null;
  const shownError = localError ?? serverMessage;

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (promote.isPending) {
      return;
    }
    const parsed = promoteTitleSchema.safeParse(title);
    if (!parsed.success) {
      setLocalError(parsed.error.issues[0]?.message ?? "Use a shorter title");
      return;
    }
    setLocalError(null);
    onSubmit(parsed.data === "" ? null : parsed.data);
  }

  return (
    <form noValidate onSubmit={handleSubmit} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>Promote to a scenario</DialogTitle>
        <DialogDescription>
          Creates a scenario in review from the repro of this finding, so the failure is checked on
          every later run. It does not run until someone accepts it.
        </DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={titleId}>Scenario title (optional)</Label>
        <Input
          id={titleId}
          value={title}
          autoComplete="off"
          disabled={promote.isPending}
          maxLength={PROMOTE_TITLE_MAX_LENGTH}
          placeholder={`Regression: ${findingTitle}`}
          aria-invalid={shownError !== null}
          aria-describedby={shownError === null ? hintId : `${hintId} ${errorId}`}
          onChange={(event) => {
            setTitle(event.target.value);
            setLocalError(null);
            onTitleEdited();
          }}
        />
        <p id={hintId} className="text-xs text-muted-foreground">
          Leave it empty to use the title shown above.
        </p>
        {shownError === null ? null : (
          <p id={errorId} role="alert" className="text-xs font-medium text-destructive">
            {shownError}
            {requestId === null || localError !== null ? null : (
              <span className="ml-1 font-mono">Request ID: {requestId}</span>
            )}
          </p>
        )}
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" disabled={promote.isPending} onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={promote.isPending} aria-busy={promote.isPending}>
          {promote.isPending ? (
            <LoaderCircle aria-hidden="true" data-icon="inline-start" className="animate-spin" />
          ) : null}
          Create scenario
        </Button>
      </DialogFooter>
    </form>
  );
}

export function PromoteDialog({ finding }: PromoteDialogProps) {
  const [open, setOpen] = useState(false);
  const promote = usePromoteFinding(finding.id);
  const idempotency = useIdempotencyKey();

  function handleOpenChange(next: boolean): void {
    if (!next && promote.isPending) {
      return;
    }
    if (next) {
      promote.reset();
    }
    setOpen(next);
  }

  function handleSubmit(title: string | null): void {
    promote.mutate(
      { title, idempotencyKey: idempotency.key },
      {
        onSuccess: (scenario) => {
          idempotency.rotate();
          setOpen(false);
          toast.success("Scenario created", {
            description: (
              <Link
                href={scenarioHref(scenario.id)}
                className="font-medium underline underline-offset-4"
              >
                Open the scenario, it is in review
              </Link>
            ),
          });
        },
      },
    );
  }

  function handleTitleEdited(): void {
    if (promote.isError) {
      idempotency.rotate();
      promote.reset();
    }
  }

  if (finding.promoted_scenario_id !== null) {
    return (
      <Button asChild variant="outline" size="sm">
        <Link href={scenarioHref(finding.promoted_scenario_id)}>
          <ExternalLink aria-hidden="true" data-icon="inline-start" />
          Open promoted scenario
        </Link>
      </Button>
    );
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <RequiresPermission action="findings.promote">
        {({ disabled }) => (
          <DialogTrigger asChild>
            <Button type="button" variant="outline" size="sm" disabled={disabled}>
              <Rocket aria-hidden="true" data-icon="inline-start" />
              Promote to scenario
            </Button>
          </DialogTrigger>
        )}
      </RequiresPermission>
      <DialogContent className="sm:max-w-lg">
        <PromoteForm
          findingTitle={finding.title}
          promote={promote}
          onTitleEdited={handleTitleEdited}
          onSubmit={handleSubmit}
          onClose={() => handleOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}
