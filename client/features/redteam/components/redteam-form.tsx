"use client";

import { useQuery } from "@tanstack/react-query";
import { TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useId, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { catalogQuery } from "@/features/catalog/queries";
import { StartFormShell } from "@/features/runs/components/start-form-shell";
import { describeApiError } from "@/lib/api/errors";
import { settingsRoutes } from "@/lib/routes";
import { useHydrated } from "@/lib/use-hydrated";
import { readRequestId } from "@/components/states/request-id";
import { isSkepticNotIndependent, SKEPTIC_NOT_INDEPENDENT_MESSAGE } from "../errors";
import { useStartRedTeam } from "../mutations";
import { redteamFamiliesQuery } from "../queries";
import {
  EMPTY_RED_TEAM_FORM,
  MAX_ROUNDS_LIMIT,
  toRedTeamCreate,
  validateRedTeamForm,
  type RedTeamFormValues,
} from "../schemas";

export type RedteamFormProps = {
  targetId: string;
};

const FAMILY_SKELETON_ROWS = 4;

function SkepticNotIndependentAlert() {
  return (
    <Alert variant="destructive" role="alert" data-slot="skeptic-not-independent">
      <TriangleAlert aria-hidden="true" />
      <AlertTitle>The skeptic model must differ from the attack model</AlertTitle>
      <AlertDescription>
        <p>
          {SKEPTIC_NOT_INDEPENDENT_MESSAGE} A breach is only believed when a second, independent
          model confirms it.{" "}
          <Link href={settingsRoutes.root()} className="underline underline-offset-3">
            Open Settings to change a model
          </Link>
        </p>
      </AlertDescription>
    </Alert>
  );
}

function incompleteReasonOf(errors: ReturnType<typeof validateRedTeamForm>): string | null {
  return errors.role ?? errors.families ?? errors.max_rounds ?? null;
}

export function RedteamForm({ targetId }: RedteamFormProps) {
  const hydrated = useHydrated();
  const roleId = useId();
  const roundsId = useId();
  const roundsErrorId = useId();
  const [values, setValues] = useState<RedTeamFormValues>(EMPTY_RED_TEAM_FORM);
  const start = useStartRedTeam();
  const catalog = useQuery(catalogQuery({ targetId, bundleId: null, filters: {} }));
  const families = useQuery(redteamFamiliesQuery());

  const roles = catalog.data?.roles ?? [];
  const role = values.role !== "" ? values.role : roles.length === 1 ? (roles[0]?.id ?? "") : "";
  const effective: RedTeamFormValues = { ...values, role };
  const errors = validateRedTeamForm(effective);
  const incompleteReason = incompleteReasonOf(errors);
  const roundsError = values.max_rounds.trim() === "" ? undefined : errors.max_rounds;
  const familyList = families.data ?? [];

  function toggleFamily(familyId: string, checked: boolean): void {
    setValues((current) => ({
      ...current,
      families: checked
        ? [...current.families, familyId]
        : current.families.filter((item) => item !== familyId),
    }));
  }

  function describeError(error: unknown) {
    return isSkepticNotIndependent(error) ? <SkepticNotIndependentAlert /> : null;
  }

  const roleControl =
    !hydrated || catalog.isPending ? (
      <Skeleton className="h-9 w-64" />
    ) : catalog.isError ? (
      <div role="alert" data-slot="roles-error" className="flex flex-col items-start gap-2 text-sm">
        <p className="text-destructive">
          Could not load the roles of this target: {describeApiError(catalog.error)}
          {readRequestId(catalog.error) === null
            ? ""
            : ` (request ${readRequestId(catalog.error)})`}
        </p>
        <Button type="button" variant="outline" size="sm" onClick={() => void catalog.refetch()}>
          Try again
        </Button>
      </div>
    ) : roles.length === 0 ? (
      <p role="status" className="text-sm text-muted-foreground">
        The latest bundle of this target declares no roles, so there is nothing to attack as.
      </p>
    ) : (
      <Select
        value={role}
        onValueChange={(next) => setValues((current) => ({ ...current, role: next }))}
      >
        <SelectTrigger id={roleId} aria-label="Role to attack as" className="w-64 max-w-full">
          <SelectValue placeholder="Choose a role" />
        </SelectTrigger>
        <SelectContent position="popper" align="start">
          {roles.map((item) => (
            <SelectItem key={item.id} value={item.id}>
              {item.id}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );

  const familyControl =
    !hydrated || families.isPending ? (
      <div role="status" aria-busy="true" className="flex flex-col gap-2">
        <span className="sr-only">Loading the attack families</span>
        {Array.from({ length: FAMILY_SKELETON_ROWS }, (_, index) => (
          <Skeleton key={index} className="h-9 w-full" />
        ))}
      </div>
    ) : families.isError ? (
      <div role="alert" data-slot="families-error" className="flex flex-col items-start gap-2 text-sm">
        <p className="text-destructive">
          Could not load the attack families: {describeApiError(families.error)}
          {readRequestId(families.error) === null
            ? ""
            : ` (request ${readRequestId(families.error)})`}
        </p>
        <Button type="button" variant="outline" size="sm" onClick={() => void families.refetch()}>
          Try again
        </Button>
      </div>
    ) : (
      <>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() =>
              setValues((current) => ({ ...current, families: familyList.map((item) => item.id) }))
            }
          >
            Select all
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setValues((current) => ({ ...current, families: [] }))}
          >
            Clear
          </Button>
        </div>
        <ul className="flex flex-col gap-2">
          {familyList.map((family) => {
            const checkId = `${roleId}-family-${family.id}`;
            return (
              <li key={family.id} className="flex items-start gap-2">
                <Checkbox
                  id={checkId}
                  checked={values.families.includes(family.id)}
                  onCheckedChange={(next) => toggleFamily(family.id, next === true)}
                  className="mt-0.5"
                />
                <Label htmlFor={checkId} className="flex-col items-start gap-0.5 leading-snug font-normal">
                  <span className="font-medium">{family.title}</span>
                  <span className="text-xs text-muted-foreground">{family.description}</span>
                </Label>
              </li>
            );
          })}
        </ul>
      </>
    );

  return (
    <StartFormShell
      targetId={targetId}
      action="redteam.start"
      label="Start a red team run"
      submitLabel="Start red team run"
      pendingLabel="Starting the run"
      productionPolicy="blocked"
      isPending={start.isPending}
      error={start.error}
      canSubmit={incompleteReason === null}
      incompleteReason={incompleteReason}
      describeError={describeError}
      onSubmit={(budget) => start.start(toRedTeamCreate(effective, targetId, budget))}
    >
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor={roleId}>Role to attack as</FieldLabel>
          {roleControl}
          <FieldDescription>
            The attacker talks to the target through this role, so what it may see and do is judged
            against this role.
          </FieldDescription>
        </Field>
        <FieldSet>
          <FieldLegend variant="label">Attack families</FieldLegend>
          <FieldDescription>
            Each round attacks with one family. The run stops after two rounds in a row where
            nothing gets through.
          </FieldDescription>
          {familyControl}
        </FieldSet>
        <Field data-invalid={roundsError === undefined ? undefined : true}>
          <FieldLabel htmlFor={roundsId}>Maximum rounds (optional)</FieldLabel>
          <Input
            id={roundsId}
            type="text"
            inputMode="numeric"
            autoComplete="off"
            value={values.max_rounds}
            placeholder={`Server default, up to ${MAX_ROUNDS_LIMIT}`}
            aria-invalid={roundsError === undefined ? undefined : true}
            aria-describedby={roundsError === undefined ? undefined : roundsErrorId}
            onChange={(event) =>
              setValues((current) => ({ ...current, max_rounds: event.target.value }))
            }
            className="w-48 max-w-full"
          />
          {roundsError === undefined ? null : (
            <p id={roundsErrorId} role="alert" className="text-xs text-destructive">
              {roundsError}
            </p>
          )}
        </Field>
      </FieldGroup>
    </StartFormShell>
  );
}
