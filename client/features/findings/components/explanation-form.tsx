"use client";

import { useQuery } from "@tanstack/react-query";
import { LoaderCircle, SendHorizontal } from "lucide-react";
import { useId, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { RequiresPermission } from "@/components/requires-permission";
import { readRequestId } from "@/components/states/request-id";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { limitsQuery } from "@/features/bundles/queries";
import { useIdempotencyKey } from "@/lib/api/idempotency";
import { useCanDo } from "@/lib/auth/can";
import { describeExplanationError, useAddExplanation } from "../detail-mutations";
import { countCharacters, explanationSchema } from "../detail-schemas";

export interface ExplanationFormProps {
  findingId: string;
}

export function describeCounter(used: number, max: number | null): string {
  const usedText = used.toLocaleString("en-US");
  return max === null
    ? `${usedText} characters`
    : `${usedText} of ${max.toLocaleString("en-US")} characters`;
}

export function ExplanationForm({ findingId }: ExplanationFormProps) {
  const access = useCanDo("findings.explain");
  const textId = useId();
  const counterId = useId();
  const errorId = useId();
  const limits = useQuery(limitsQuery());
  const add = useAddExplanation(findingId);
  const idempotency = useIdempotencyKey();
  const [text, setText] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);

  const maxChars = limits.data?.explanation_max_chars ?? null;
  const used = countCharacters(text);
  const limitMessage =
    maxChars !== null && used > maxChars
      ? `Use at most ${maxChars.toLocaleString("en-US")} characters`
      : null;
  const overLimit = limitMessage !== null;
  const empty = text.trim() === "";
  const serverMessage = add.isError ? describeExplanationError(add.error, maxChars) : null;
  const requestId = add.isError ? readRequestId(add.error) : null;
  const shownError = localError ?? serverMessage ?? limitMessage;
  const blocked = !access.allowed || add.isPending;

  function handleChange(value: string): void {
    setText(value);
    setLocalError(null);
    if (add.isError) {
      idempotency.rotate();
      add.reset();
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (blocked) {
      return;
    }
    const parsed = explanationSchema(maxChars).safeParse(text);
    if (!parsed.success) {
      setLocalError(parsed.error.issues[0]?.message ?? "Paste Claude Code's answer first");
      return;
    }
    setLocalError(null);
    add.mutate(
      { text: parsed.data, idempotencyKey: idempotency.key },
      {
        onSuccess: () => {
          setText("");
          idempotency.rotate();
          toast.success("Explanation added");
        },
      },
    );
  }

  return (
    <form
      noValidate
      onSubmit={handleSubmit}
      data-slot="explanation-form"
      className="flex flex-col gap-2"
    >
      <Label htmlFor={textId}>Claude Code&apos;s answer</Label>
      <Textarea
        id={textId}
        value={text}
        rows={8}
        spellCheck={false}
        autoComplete="off"
        disabled={!access.allowed}
        placeholder="Paste Claude Code's answer here"
        aria-invalid={shownError !== null}
        aria-describedby={shownError === null ? counterId : `${counterId} ${errorId}`}
        className="max-h-96 overflow-y-auto font-mono text-xs"
        onChange={(event) => handleChange(event.target.value)}
      />
      <p
        id={counterId}
        className={
          overLimit ? "text-xs font-medium text-destructive" : "text-xs text-muted-foreground"
        }
      >
        {describeCounter(used, maxChars)}
      </p>
      {shownError === null ? null : (
        <p id={errorId} role="alert" className="text-xs font-medium text-destructive">
          {shownError}
          {requestId === null || localError !== null ? null : (
            <span className="ml-1 font-mono">Request ID: {requestId}</span>
          )}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <RequiresPermission action="findings.explain">
          {() => (
            <Button
              type="submit"
              size="sm"
              disabled={blocked || empty || overLimit}
              aria-busy={add.isPending}
            >
              {add.isPending ? (
                <LoaderCircle
                  aria-hidden="true"
                  data-icon="inline-start"
                  className="animate-spin"
                />
              ) : (
                <SendHorizontal aria-hidden="true" data-icon="inline-start" />
              )}
              Add explanation
            </Button>
          )}
        </RequiresPermission>
        <p className="text-xs text-muted-foreground">
          Shown as plain text. Nothing in it is run or rendered as markup.
        </p>
      </div>
    </form>
  );
}
