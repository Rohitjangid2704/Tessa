"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useId } from "react";
import { Controller, useFormState, useWatch, type UseFormReturn } from "react-hook-form";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldLabel, FieldSet, FieldLegend } from "@/components/ui/field";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { goalOptionsQuery } from "@/features/simulators/queries";
import { GOAL_KIND_HELP, GOAL_KIND_LABELS, GOAL_KINDS } from "@/features/simulators/schemas";
import { describeApiError } from "@/lib/api/errors";
import { simulatorRoutes } from "@/lib/routes";
import { GOAL_TEXT_MAX_LENGTH, GOAL_MODES, type ExplorationFormValues, type GoalMode } from "../schemas";

const MODE_LABELS: Record<GoalMode, string> = {
  text: "Describe a goal",
  saved: "Use a saved goal",
};

function isGoalMode(value: string): value is GoalMode {
  return (GOAL_MODES as readonly string[]).includes(value);
}

export type GoalPickerProps = {
  targetId: string;
  form: UseFormReturn<ExplorationFormValues>;
};

function SavedGoalField({ targetId, form }: GoalPickerProps) {
  const selectId = useId();
  const goals = useQuery(goalOptionsQuery(targetId));
  const { errors } = useFormState({ control: form.control, name: "goal_id" });
  const selectedId = useWatch({ control: form.control, name: "goal_id" });
  const items = goals.data ?? [];
  const selected = items.find((goal) => goal.id === selectedId);

  if (goals.isPending) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Loading the saved goals
      </p>
    );
  }
  if (goals.isError) {
    return (
      <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-destructive">
        <span>Saved goals could not be loaded: {describeApiError(goals.error)}</span>
        <Button type="button" size="sm" variant="outline" onClick={() => void goals.refetch()}>
          Retry
        </Button>
      </div>
    );
  }
  if (items.length === 0) {
    return (
      <p className="text-sm text-muted-foreground" data-slot="no-saved-goals">
        This target has no saved goals yet.{" "}
        <Link
          href={simulatorRoutes.list(targetId, "goals")}
          className="underline underline-offset-3"
        >
          Create one under Simulators
        </Link>{" "}
        or describe a goal instead.
      </p>
    );
  }
  return (
    <Field data-invalid={errors.goal_id ? true : undefined}>
      <FieldLabel htmlFor={selectId}>Saved goal</FieldLabel>
      <Controller
        control={form.control}
        name="goal_id"
        render={({ field }) => (
          <Select value={field.value} onValueChange={field.onChange}>
            <SelectTrigger
              id={selectId}
              className="w-full max-w-md"
              aria-invalid={errors.goal_id ? true : undefined}
            >
              <SelectValue placeholder="Choose a saved goal" />
            </SelectTrigger>
            <SelectContent position="popper" align="start">
              {items.map((goal) => (
                <SelectItem key={goal.id} value={goal.id}>
                  {goal.title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      />
      {selected === undefined ? null : (
        <FieldDescription data-slot="saved-goal-statement">
          {GOAL_KIND_LABELS[selected.kind]}: {selected.statement}
        </FieldDescription>
      )}
      <FieldError errors={[errors.goal_id]} />
    </Field>
  );
}

function GoalTextFields({ form }: { form: UseFormReturn<ExplorationFormValues> }) {
  const textId = useId();
  const kindId = useId();
  const { errors } = useFormState({ control: form.control });
  const text = useWatch({ control: form.control, name: "goal_text" });
  const kind = useWatch({ control: form.control, name: "goal_kind" });

  return (
    <div className="flex flex-col gap-4">
      <Field data-invalid={errors.goal_text ? true : undefined}>
        <FieldLabel htmlFor={textId}>What should the explorer try?</FieldLabel>
        <Textarea
          id={textId}
          rows={3}
          maxLength={GOAL_TEXT_MAX_LENGTH}
          placeholder="As a team member, try to see a private document"
          aria-invalid={errors.goal_text ? true : undefined}
          {...form.register("goal_text")}
        />
        <FieldDescription>
          {text.length} of {GOAL_TEXT_MAX_LENGTH} characters
        </FieldDescription>
        <FieldError errors={[errors.goal_text]} />
      </Field>
      <Field data-invalid={errors.goal_kind ? true : undefined}>
        <FieldLabel htmlFor={kindId}>Kind of goal</FieldLabel>
        <Controller
          control={form.control}
          name="goal_kind"
          render={({ field }) => (
            <Select value={field.value} onValueChange={field.onChange}>
              <SelectTrigger id={kindId} className="w-full max-w-md">
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper" align="start">
                {GOAL_KINDS.map((goalKind) => (
                  <SelectItem key={goalKind} value={goalKind}>
                    {GOAL_KIND_LABELS[goalKind]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        />
        <FieldDescription>{GOAL_KIND_HELP[kind]}</FieldDescription>
        <FieldError errors={[errors.goal_kind]} />
      </Field>
    </div>
  );
}

export function GoalPicker({ targetId, form }: GoalPickerProps) {
  const groupId = useId();
  const mode = useWatch({ control: form.control, name: "goal_mode" });

  function changeMode(next: string): void {
    if (!isGoalMode(next)) {
      return;
    }
    form.setValue("goal_mode", next);
    form.clearErrors(["goal_id", "goal_text"]);
  }

  return (
    <FieldSet data-slot="goal-picker">
      <FieldLegend variant="label">Goal</FieldLegend>
      <RadioGroup
        value={mode}
        onValueChange={changeMode}
        aria-label="How to give the goal"
        className="flex flex-wrap gap-x-6 gap-y-2"
      >
        {GOAL_MODES.map((option) => (
          <div key={option} className="flex items-center gap-2">
            <RadioGroupItem id={`${groupId}-${option}`} value={option} />
            <Label htmlFor={`${groupId}-${option}`} className="font-normal">
              {MODE_LABELS[option]}
            </Label>
          </div>
        ))}
      </RadioGroup>
      {mode === "saved" ? (
        <SavedGoalField targetId={targetId} form={form} />
      ) : (
        <GoalTextFields form={form} />
      )}
    </FieldSet>
  );
}
