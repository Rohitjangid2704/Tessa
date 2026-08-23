"use client";

import { Check, CircleAlert, LoaderCircle } from "lucide-react";
import { useId, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { readRequestId } from "@/components/states/request-id";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import { describeApiError } from "@/lib/api/errors";
import { fieldMessagesFromApiError, type FieldMessages } from "@/lib/api/form-errors";
import type { LabelCreate, LabelSubjectType, LabelValue } from "@/lib/api/types";
import { useCanDo } from "@/lib/auth/can";
import { AttemptKeyRing, labelFingerprint } from "../attempt-keys";
import { useCreateLabel } from "../mutations";
import {
  isCorrectionSubject,
  LABEL_NOTE_MAX_LENGTH,
  LABEL_SUBJECT_NOUNS,
  LABEL_VALUE_HINTS,
  LABEL_VALUE_LABELS,
  LABEL_VALUES,
  labelCreateSchema,
} from "../schemas";

export type CallKey = "primary" | "step";

export type CallStatus = "idle" | "saving" | "saved" | "failed";

export interface CallState {
  status: CallStatus;
  replaced: boolean;
  error: unknown;
}

export type CallStates = Record<CallKey, CallState>;

const IDLE_CALL: CallState = { status: "idle", replaced: false, error: null };
const IDLE_CALLS: CallStates = { primary: IDLE_CALL, step: IDLE_CALL };
const FORM_FIELDS = ["value", "note"] as const;

export interface LabelDialogProps {
  subjectType: LabelSubjectType;
  subjectId: string;
  stepId?: string | null;
  runId?: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialValue?: LabelValue;
  initialNote?: string;
}

const DESCRIPTIONS: Record<LabelSubjectType, string> = {
  judge_result:
    "Say what the verdict of this step should have been. This marks the judge as wrong.",
  probe_result:
    "Say what the verdict of this step should have been. This marks the probe as wrong.",
  step: "Set the verdict of this step. It replaces the machine verdict and updates the run counters.",
  invariant_result:
    "Label this invariant result. It is calibration data and does not change the run.",
};

export function describeCall(key: CallKey, subjectType: LabelSubjectType): string {
  return key === "primary"
    ? `Label on the ${LABEL_SUBJECT_NOUNS[subjectType]}`
    : "Label on the step verdict";
}

export function describeCallStatus(call: CallState): string {
  switch (call.status) {
    case "idle":
      return "waiting";
    case "saving":
      return "saving";
    case "saved":
      return call.replaced ? "saved, replaced your earlier label" : "saved";
    case "failed":
      return "failed";
  }
}

function plannedCalls(includesStep: boolean): CallKey[] {
  return includesStep ? ["primary", "step"] : ["primary"];
}

function buildLabel(
  key: CallKey,
  props: Pick<LabelDialogProps, "subjectType" | "subjectId" | "stepId">,
  value: LabelValue,
  note: string,
): LabelCreate {
  const trimmed = note.trim();
  const base =
    key === "primary"
      ? { subject_type: props.subjectType, subject_id: props.subjectId, value }
      : { subject_type: "step" as const, subject_id: props.stepId ?? "", value };
  return trimmed === "" ? base : { ...base, note: trimmed };
}

function retryLabel(calls: CallStates, plan: readonly CallKey[]): string | null {
  const failed = plan.find((key) => calls[key].status === "failed");
  if (failed === undefined) {
    return null;
  }
  const anySaved = plan.some((key) => calls[key].status === "saved");
  if (!anySaved) {
    return "Try again";
  }
  return failed === "step" ? "Retry step label" : "Retry label";
}

interface LabelDialogFormProps extends Omit<LabelDialogProps, "open"> {
  onBusyChange: (busy: boolean) => void;
}

function LabelDialogForm({
  subjectType,
  subjectId,
  stepId,
  runId,
  onOpenChange,
  onBusyChange,
  initialValue,
  initialNote,
}: LabelDialogFormProps) {
  const { allowed: canLabel, isPending: rolePending } = useCanDo("labels.create");
  const createLabel = useCreateLabel();
  const noteId = useId();
  const valueErrorId = useId();
  const noteErrorId = useId();
  const stepToggleId = useId();
  const [attemptKeys] = useState(() => new AttemptKeyRing());
  const [value, setValue] = useState<LabelValue | null>(initialValue ?? null);
  const [note, setNote] = useState(initialNote ?? "");
  const [alsoStep, setAlsoStep] = useState(true);
  const [calls, setCalls] = useState<CallStates>(IDLE_CALLS);
  const [fieldErrors, setFieldErrors] = useState<FieldMessages>({});

  const stepApplies =
    isCorrectionSubject(subjectType) && stepId !== undefined && stepId !== null && stepId !== "";
  const plan = plannedCalls(stepApplies && alsoStep);
  const saving = plan.some((key) => calls[key].status === "saving");
  const anySaved = Object.values(calls).some((call) => call.status === "saved");
  const retry = retryLabel(calls, plan);
  const failedKey = plan.find((key) => calls[key].status === "failed");
  const failure = failedKey === undefined ? null : calls[failedKey].error;
  const attempted = Object.values(calls).some((call) => call.status !== "idle");
  const noun = LABEL_SUBJECT_NOUNS[subjectType];

  function record(key: CallKey, next: CallState): void {
    setCalls((previous) => ({ ...previous, [key]: next }));
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!canLabel || saving) {
      return;
    }
    if (value === null) {
      setFieldErrors({ value: "Choose what the verdict should be" });
      return;
    }
    const parsed = labelCreateSchema.safeParse(
      buildLabel("primary", { subjectType, subjectId, stepId }, value, note),
    );
    if (!parsed.success) {
      setFieldErrors({ note: `Keep the note under ${LABEL_NOTE_MAX_LENGTH} characters` });
      return;
    }
    setFieldErrors({});
    onBusyChange(true);
    try {
      for (const key of plan) {
        if (calls[key].status === "saved") {
          continue;
        }
        const label = buildLabel(key, { subjectType, subjectId, stepId }, value, note);
        const fingerprint = labelFingerprint(label);
        record(key, { status: "saving", replaced: false, error: null });
        try {
          const result = await createLabel.mutateAsync({
            label,
            idempotencyKey: attemptKeys.keyFor(fingerprint),
            runId,
          });
          attemptKeys.settle(fingerprint);
          record(key, { status: "saved", replaced: result.replaced, error: null });
          const subjectNoun = key === "primary" ? noun : "step";
          toast.success(
            result.replaced
              ? `Replaced your earlier label of this ${subjectNoun}`
              : `Saved your label of this ${subjectNoun}`,
          );
        } catch (error) {
          record(key, { status: "failed", replaced: false, error });
          setFieldErrors(fieldMessagesFromApiError(error, FORM_FIELDS).byField);
          return;
        }
      }
      onOpenChange(false);
    } finally {
      onBusyChange(false);
    }
  }

  const valueMessage = fieldErrors.value;
  const noteMessage = fieldErrors.note;
  const locked = saving || anySaved;

  return (
    <form onSubmit={(event) => void submit(event)} className="grid gap-4" noValidate>
      <DialogHeader>
        <DialogTitle>What should the verdict be?</DialogTitle>
        <DialogDescription>{DESCRIPTIONS[subjectType]}</DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-1.5">
        <RadioGroup
          value={value ?? ""}
          onValueChange={(next) => {
            setValue(LABEL_VALUES.find((candidate) => candidate === next) ?? null);
            setFieldErrors((previous) => ({ ...previous, value: undefined }));
          }}
          aria-label="Corrected verdict"
          aria-invalid={valueMessage !== undefined}
          aria-describedby={valueMessage === undefined ? undefined : valueErrorId}
          disabled={locked || !canLabel}
        >
          {LABEL_VALUES.map((option) => {
            const optionId = `${noteId}-${option}`;
            return (
              <div key={option} className="flex items-start gap-2">
                <RadioGroupItem id={optionId} value={option} className="mt-0.5" />
                <Label htmlFor={optionId} className="flex flex-col items-start gap-0 font-normal">
                  <span className="font-medium">{LABEL_VALUE_LABELS[option]}</span>
                  <span className="text-xs text-muted-foreground">{LABEL_VALUE_HINTS[option]}</span>
                </Label>
              </div>
            );
          })}
        </RadioGroup>
        {valueMessage === undefined ? null : (
          <p id={valueErrorId} role="alert" className="text-sm text-destructive">
            {valueMessage}
          </p>
        )}
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={noteId}>Note (optional)</Label>
        <Textarea
          id={noteId}
          value={note}
          rows={3}
          maxLength={LABEL_NOTE_MAX_LENGTH}
          disabled={locked || !canLabel}
          autoComplete="off"
          aria-invalid={noteMessage !== undefined}
          aria-describedby={noteMessage === undefined ? undefined : noteErrorId}
          onChange={(event) => setNote(event.target.value)}
        />
        {noteMessage === undefined ? null : (
          <p id={noteErrorId} role="alert" className="text-sm text-destructive">
            {noteMessage}
          </p>
        )}
      </div>
      {stepApplies ? (
        <div className="flex items-start gap-2">
          <Checkbox
            id={stepToggleId}
            checked={alsoStep}
            disabled={locked || !canLabel}
            className="mt-0.5"
            onCheckedChange={(checked) => setAlsoStep(checked === true)}
          />
          <Label htmlFor={stepToggleId} className="flex flex-col items-start gap-0 font-normal">
            <span className="font-medium">Also set the verdict of the step</span>
            <span className="text-xs text-muted-foreground">
              Only a step label changes the verdict and the run counters. Without it this is
              calibration data only.
            </span>
          </Label>
        </div>
      ) : null}
      {attempted ? (
        <ul aria-label="Label requests" className="flex flex-col gap-1 text-sm">
          {plan.map((key) => {
            const call = calls[key];
            const Icon =
              call.status === "saved"
                ? Check
                : call.status === "saving"
                  ? LoaderCircle
                  : call.status === "failed"
                    ? CircleAlert
                    : null;
            return (
              <li
                key={key}
                data-call={key}
                data-status={call.status}
                className="flex items-center gap-2"
              >
                {Icon === null ? (
                  <span className="size-4" aria-hidden="true" />
                ) : (
                  <Icon
                    aria-hidden="true"
                    className={call.status === "saving" ? "size-4 animate-spin" : "size-4"}
                  />
                )}
                <span>
                  {describeCall(key, subjectType)}: {describeCallStatus(call)}
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
      {failure === null ? null : (
        <div
          role="alert"
          className="flex flex-col gap-1 rounded-lg border border-destructive/30 p-3 text-sm"
        >
          <p>
            {anySaved
              ? `The label on the ${noun} is saved, but the step label was not. Retrying sends only the step label.`
              : "Your label was not saved."}
          </p>
          <p className="text-muted-foreground">{describeApiError(failure)}</p>
          {readRequestId(failure) === null ? null : (
            <p className="font-mono text-xs text-muted-foreground">
              Request ID: {readRequestId(failure)}
            </p>
          )}
        </div>
      )}
      {canLabel || rolePending ? null : (
        <p className="text-sm text-muted-foreground">
          You have the viewer role, so you can read labels but not create them.
        </p>
      )}
      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          disabled={saving}
          onClick={() => onOpenChange(false)}
        >
          {anySaved ? "Close" : "Cancel"}
        </Button>
        <Button type="submit" disabled={!canLabel || saving} aria-busy={saving}>
          {saving ? (
            <LoaderCircle aria-hidden="true" data-icon="inline-start" className="animate-spin" />
          ) : null}
          {saving ? "Saving" : (retry ?? "Save label")}
        </Button>
      </DialogFooter>
    </form>
  );
}

export function LabelDialog({ open, onOpenChange, ...props }: LabelDialogProps) {
  const [busy, setBusy] = useState(false);

  function handleOpenChange(next: boolean): void {
    if (!next && busy) {
      return;
    }
    onOpenChange(next);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <LabelDialogForm {...props} onOpenChange={onOpenChange} onBusyChange={setBusy} />
      </DialogContent>
    </Dialog>
  );
}
