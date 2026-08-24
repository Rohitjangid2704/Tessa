"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { TriangleAlert, type LucideIcon } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { useForm, useWatch, type UseFormReturn } from "react-hook-form";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { SettingsPatch, SettingsRead } from "@/lib/api/types";
import {
  buildSettingsPatch,
  countChangedLeaves,
  describeSaved,
  isPatchEmpty,
  type SectionInput,
} from "../build-patch";
import { describeSaveFailure, type SaveFailure } from "../errors";
import { usePatchSettings } from "../mutations";
import {
  createSectionSchema,
  defaultSectionValues,
  sectionRevision,
  type SectionFormValues,
  type SettingsGroup,
} from "../schemas";
import { useReportDirty } from "../unsaved-changes";

export interface SectionApi {
  group: SettingsGroup;
  settings: SettingsRead;
  form: UseFormReturn<SectionFormValues>;
  readOnly: boolean;
  isSaving: boolean;
  serverError: (leafId: string) => string | undefined;
}

interface SubmittedFailure extends SaveFailure {
  submitted: Readonly<Record<string, string>>;
}

export interface SettingsSectionProps {
  group: SettingsGroup;
  title: string;
  description: string;
  icon: LucideIcon;
  settings: SettingsRead;
  readOnly: boolean;
  children: (api: SectionApi) => ReactNode;
}

interface SectionFormProps {
  group: SettingsGroup;
  title: string;
  settings: SettingsRead;
  readOnly: boolean;
  isSaving: boolean;
  failure: SubmittedFailure | null;
  onSave: (patch: SettingsPatch, submitted: Readonly<Record<string, string>>) => void;
  children: (api: SectionApi) => ReactNode;
}

function describeChanges(count: number): string {
  if (count === 0) {
    return "No unsaved changes";
  }
  return `${count} unsaved ${count === 1 ? "change" : "changes"}`;
}

function SectionForm({
  group,
  title,
  settings,
  readOnly,
  isSaving,
  failure,
  onSave,
  children,
}: SectionFormProps) {
  const form = useForm<SectionFormValues>({
    resolver: zodResolver(createSectionSchema(group)),
    defaultValues: defaultSectionValues(group, settings),
    mode: "onChange",
  });
  const watched = useWatch({ control: form.control });
  const input: SectionInput = { values: watched.values ?? {}, reset: watched.reset ?? {} };
  const changeCount = countChangedLeaves(settings, group, input);
  useReportDirty(group, changeCount > 0);

  const submit = form.handleSubmit((submitted) => {
    const patch = buildSettingsPatch(settings, { [group]: submitted });
    if (!isPatchEmpty(patch)) {
      onSave(patch, submitted.values);
    }
  });

  function serverError(leafId: string): string | undefined {
    const message = failure?.fieldMessages[leafId];
    const unchanged = failure?.submitted[leafId] === (input.values[leafId] ?? "");
    return unchanged ? message : undefined;
  }

  return (
    <form
      aria-label={title}
      noValidate
      autoComplete="off"
      onSubmit={submit}
      className="flex flex-col gap-5"
    >
      {failure?.message ? (
        <Alert variant="destructive" data-slot="save-failure">
          <TriangleAlert aria-hidden="true" />
          <AlertTitle>Could not save {title.toLowerCase()}</AlertTitle>
          <AlertDescription>{failure.message}</AlertDescription>
        </Alert>
      ) : null}
      {children({ group, settings, form, readOnly, isSaving, serverError })}
      {readOnly ? null : (
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={changeCount === 0 || isSaving}>
            {isSaving ? "Saving" : "Save changes"}
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={changeCount === 0 || isSaving}
            onClick={() => form.reset(defaultSectionValues(group, settings))}
          >
            Discard changes
          </Button>
          <p className="text-sm text-muted-foreground">{describeChanges(changeCount)}</p>
        </div>
      )}
    </form>
  );
}

export function SettingsSection({
  group,
  title,
  description,
  icon: Icon,
  settings,
  readOnly,
  children,
}: SettingsSectionProps) {
  const titleId = useId();
  const save = usePatchSettings();
  const [failure, setFailure] = useState<SubmittedFailure | null>(null);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);

  function handleSave(patch: SettingsPatch, submitted: Readonly<Record<string, string>>): void {
    setFailure(null);
    setSavedMessage(null);
    save.mutate(patch, {
      onSuccess: () => setSavedMessage(describeSaved(patch)),
      onError: (error) => setFailure({ ...describeSaveFailure(error, group), submitted }),
      onSettled: () => save.reset(),
    });
  }

  return (
    <Card role="region" aria-labelledby={titleId} data-section={group}>
      <CardHeader>
        <CardTitle id={titleId} role="heading" aria-level={2} className="flex items-center gap-2">
          <Icon aria-hidden="true" className="size-4" />
          {title}
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div role="status" className={savedMessage ? "text-sm font-medium" : "sr-only"}>
          {savedMessage}
        </div>
        <SectionForm
          key={sectionRevision(group, settings)}
          group={group}
          title={title}
          settings={settings}
          readOnly={readOnly}
          isSaving={save.isPending}
          failure={failure}
          onSave={handleSave}
        >
          {children}
        </SectionForm>
      </CardContent>
    </Card>
  );
}
