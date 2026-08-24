"use client";

import { useQuery } from "@tanstack/react-query";
import { LoaderCircle, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent } from "react";
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
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useAttemptKeys } from "@/features/bundles/use-attempt-keys";
import { TargetSelect, type TargetSelectOption } from "@/features/targets/components/target-select";
import { targetOptionsQuery } from "@/features/targets/queries";
import { describeApiError } from "@/lib/api/errors";
import { fieldMessagesFromApiError, type FieldMessages } from "@/lib/api/form-errors";
import { useCan } from "@/lib/auth/can";
import { scenarioRoutes } from "@/lib/routes";
import { useHydrated } from "@/lib/use-hydrated";
import { useCreateScenario } from "../mutations";
import { newScenarioSchema, SCENARIO_YAML_MAX_LENGTH } from "../schemas";
import { checkScenarioSkeleton, SCENARIO_SKELETON_YAML } from "../skeleton";

const FORM_FIELDS = ["target_id", "yaml"] as const;

type NewScenarioFormProps = {
  initialTargetId: string | null;
  onDone: () => void;
};

function NewScenarioForm({ initialTargetId, onDone }: NewScenarioFormProps) {
  const router = useRouter();
  const yamlId = useId();
  const yamlErrorId = useId();
  const targetErrorId = useId();
  const hydrated = useHydrated();
  const targets = useQuery(targetOptionsQuery());
  const create = useCreateScenario();
  const attemptKeys = useAttemptKeys();
  const [targetId, setTargetId] = useState<string | null>(initialTargetId);
  const [yamlText, setYamlText] = useState(SCENARIO_SKELETON_YAML);
  const [fieldErrors, setFieldErrors] = useState<FieldMessages>({});

  const options: TargetSelectOption[] = hydrated
    ? (targets.data ?? []).map((target) => ({
        id: target.id,
        name: target.name,
        tier: target.tier,
      }))
    : [];
  const skeleton = checkScenarioSkeleton(yamlText);
  const failure = create.isError ? create.error : null;
  const hasFieldErrors = Object.values(fieldErrors).some((message) => message !== undefined);
  const generalFailure = failure !== null && !hasFieldErrors ? describeApiError(failure) : null;

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (create.isPending) {
      return;
    }
    const parsed = newScenarioSchema.safeParse({ target_id: targetId ?? "", yaml: yamlText });
    if (!parsed.success) {
      const messages: FieldMessages = {};
      for (const issue of parsed.error.issues) {
        const field = String(issue.path[0] ?? "");
        messages[field] ??= issue.message;
      }
      setFieldErrors(messages);
      return;
    }
    setFieldErrors({});
    create.mutate(
      {
        targetId: parsed.data.target_id,
        yaml: yamlText,
        idempotencyKey: attemptKeys.keyFor(`${parsed.data.target_id}|${yamlText}`),
      },
      {
        onSuccess: (scenario) => {
          attemptKeys.settle();
          onDone();
          router.push(scenarioRoutes.detail(scenario.id));
        },
        onError: (error) => setFieldErrors(fieldMessagesFromApiError(error, FORM_FIELDS).byField),
      },
    );
  }

  const yamlMessage = fieldErrors.yaml;
  const targetMessage = fieldErrors.target_id;

  return (
    <form onSubmit={submit} className="grid gap-4" noValidate>
      <DialogHeader>
        <DialogTitle>New scenario</DialogTitle>
        <DialogDescription>
          Write the scenario as YAML. It is saved as a draft owned by you, and the editor opens
          next with the schema and server checks.
        </DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-1.5">
        <span className="text-sm leading-none font-medium">Target</span>
        <TargetSelect
          value={targetId}
          onChange={(next) => {
            setTargetId(next);
            setFieldErrors((previous) => ({ ...previous, target_id: undefined }));
            create.reset();
          }}
          options={options}
          label="Target of the scenario"
          disabled={create.isPending}
          className="w-full"
        />
        {targetMessage === undefined ? null : (
          <p id={targetErrorId} role="alert" className="text-sm text-destructive">
            {targetMessage}
          </p>
        )}
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={yamlId}>Scenario YAML</Label>
        <Textarea
          id={yamlId}
          value={yamlText}
          rows={16}
          spellCheck={false}
          maxLength={SCENARIO_YAML_MAX_LENGTH}
          disabled={create.isPending}
          aria-invalid={yamlMessage !== undefined}
          aria-describedby={yamlMessage === undefined ? undefined : yamlErrorId}
          className="font-mono text-xs md:text-xs"
          onChange={(event) => {
            setYamlText(event.target.value);
            setFieldErrors((previous) => ({ ...previous, yaml: undefined }));
            create.reset();
          }}
        />
        {yamlMessage === undefined ? null : (
          <p id={yamlErrorId} role="alert" className="text-sm text-destructive">
            {yamlMessage}
          </p>
        )}
        {skeleton.parsable ? (
          skeleton.missingKeys.length === 0 ? null : (
            <p role="note" className="text-sm text-muted-foreground">
              Missing top level keys: {skeleton.missingKeys.join(", ")}.
            </p>
          )
        ) : (
          <p role="note" className="text-sm text-muted-foreground">
            The YAML does not parse yet: {skeleton.syntaxMessage}
          </p>
        )}
      </div>
      {generalFailure === null ? null : (
        <div role="alert" className="flex flex-col gap-1 text-sm text-destructive">
          <p>{generalFailure}</p>
          {readRequestId(failure) === null ? null : (
            <p className="font-mono text-xs text-muted-foreground">
              Request ID: {readRequestId(failure)}
            </p>
          )}
        </div>
      )}
      <DialogFooter>
        <Button type="button" variant="outline" disabled={create.isPending} onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={create.isPending} aria-busy={create.isPending}>
          {create.isPending ? (
            <LoaderCircle aria-hidden="true" data-icon="inline-start" className="animate-spin" />
          ) : null}
          {create.isPending ? "Creating" : "Create scenario"}
        </Button>
      </DialogFooter>
    </form>
  );
}

export type NewScenarioDialogProps = {
  targetId?: string | null;
};

export function NewScenarioDialog({ targetId = null }: NewScenarioDialogProps) {
  const canCreate = useCan("scenarios.create");
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          type="button"
          disabled={!canCreate}
          title={canCreate ? undefined : "Viewers cannot create scenarios"}
        >
          <Plus aria-hidden="true" data-icon="inline-start" />
          New scenario
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl">
        <NewScenarioForm initialTargetId={targetId} onDone={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  );
}
