"use client";

import { ExternalLink, LoaderCircle, Pencil, Plus } from "lucide-react";
import { useId, useState, type FormEvent } from "react";
import { RequiresPermission } from "@/components/requires-permission";
import { readRequestId } from "@/components/states/request-id";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { fieldMessagesFromApiError } from "@/lib/api/form-errors";
import type { Finding } from "@/lib/api/types";
import { safeHttpUrl } from "@/lib/safe-http-url";
import { describeFindingUpdateError, useUpdateFindingDetail } from "../detail-mutations";
import { TICKET_URL_MAX_LENGTH, ticketUrlSchema } from "../detail-schemas";

export interface TicketLinkFieldProps {
  finding: Pick<Finding, "id" | "ticket_url">;
}

interface TicketLinkEditorProps {
  findingId: string;
  initialUrl: string;
  onClose: () => void;
}

function TicketLinkEditor({ findingId, initialUrl, onClose }: TicketLinkEditorProps) {
  const inputId = useId();
  const errorId = useId();
  const update = useUpdateFindingDetail(findingId);
  const [draft, setDraft] = useState(initialUrl);
  const [localError, setLocalError] = useState<string | null>(null);

  const serverMessage = update.isError
    ? (fieldMessagesFromApiError(update.error, ["ticket_url"]).byField.ticket_url ??
      describeFindingUpdateError(update.error))
    : null;
  const requestId = update.isError ? readRequestId(update.error) : null;
  const shownError = localError ?? serverMessage;

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (update.isPending) {
      return;
    }
    const parsed = ticketUrlSchema.safeParse(draft);
    if (!parsed.success) {
      setLocalError(parsed.error.issues[0]?.message ?? "Enter a valid link");
      return;
    }
    setLocalError(null);
    update.mutate({ ticket_url: parsed.data }, { onSuccess: onClose });
  }

  function handleRemove(): void {
    update.mutate({ ticket_url: null }, { onSuccess: onClose });
  }

  return (
    <form noValidate onSubmit={handleSubmit} className="flex flex-col gap-2">
      <Label htmlFor={inputId}>Ticket link</Label>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          id={inputId}
          value={draft}
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          maxLength={TICKET_URL_MAX_LENGTH}
          placeholder="https://tracker.example.com/browse/ABC-123"
          disabled={update.isPending}
          aria-invalid={shownError !== null}
          aria-describedby={shownError === null ? undefined : errorId}
          className="min-w-0 flex-1 basis-64"
          onChange={(event) => {
            setDraft(event.target.value);
            setLocalError(null);
          }}
        />
        <Button type="submit" size="sm" disabled={update.isPending} aria-busy={update.isPending}>
          {update.isPending ? (
            <LoaderCircle aria-hidden="true" data-icon="inline-start" className="animate-spin" />
          ) : null}
          Save link
        </Button>
        <Button type="button" variant="outline" size="sm" disabled={update.isPending} onClick={onClose}>
          Cancel
        </Button>
        {initialUrl === "" ? null : (
          <Button
            type="button"
            variant="destructive"
            size="sm"
            disabled={update.isPending}
            onClick={handleRemove}
          >
            Remove link
          </Button>
        )}
      </div>
      {shownError === null ? null : (
        <p id={errorId} role="alert" className="text-xs font-medium text-destructive">
          {shownError}
          {requestId === null || localError !== null ? null : (
            <span className="ml-1 font-mono">Request ID: {requestId}</span>
          )}
        </p>
      )}
    </form>
  );
}

export function TicketLinkField({ finding }: TicketLinkFieldProps) {
  const [editing, setEditing] = useState(false);
  const safeUrl = safeHttpUrl(finding.ticket_url);

  if (editing) {
    return (
      <TicketLinkEditor
        findingId={finding.id}
        initialUrl={finding.ticket_url ?? ""}
        onClose={() => setEditing(false)}
      />
    );
  }

  return (
    <div data-slot="ticket-link-field" className="flex flex-wrap items-center gap-x-3 gap-y-2">
      {finding.ticket_url === null ? (
        <p className="text-sm text-muted-foreground">No ticket linked.</p>
      ) : safeUrl === null ? (
        <p className="min-w-0 text-sm wrap-anywhere">
          {finding.ticket_url}
          <span className="ml-1 text-muted-foreground">(not a web link, so it is not clickable)</span>
        </p>
      ) : (
        <a
          href={safeUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex min-w-0 items-center gap-1 text-sm font-medium text-primary underline underline-offset-4 wrap-anywhere"
        >
          {finding.ticket_url}
          <ExternalLink aria-hidden="true" className="size-3.5 shrink-0" />
          <span className="sr-only">(opens in a new tab)</span>
        </a>
      )}
      <RequiresPermission action="findings.update">
        {({ disabled }) => (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled}
            onClick={() => setEditing(true)}
          >
            {finding.ticket_url === null ? (
              <Plus aria-hidden="true" data-icon="inline-start" />
            ) : (
              <Pencil aria-hidden="true" data-icon="inline-start" />
            )}
            {finding.ticket_url === null ? "Add ticket link" : "Edit link"}
          </Button>
        )}
      </RequiresPermission>
    </div>
  );
}
