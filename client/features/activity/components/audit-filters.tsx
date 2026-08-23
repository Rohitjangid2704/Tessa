"use client";

import { X } from "lucide-react";
import { useId } from "react";
import { FilterBar } from "@/components/filter-bar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { User } from "@/lib/api/types";
import { shortId } from "../detail";
import {
  AUDIT_SUBJECT_LABELS,
  AUDIT_SUBJECT_TYPES,
  AUDIT_VIA_LABELS,
  AUDIT_VIA_VALUES,
} from "../labels";
import type { AuditFilterValues } from "../schemas";
import { FilterSelect } from "./filter-select";

const VIA_OPTIONS = AUDIT_VIA_VALUES.map((value) => ({ value, label: AUDIT_VIA_LABELS[value] }));
const SUBJECT_OPTIONS = AUDIT_SUBJECT_TYPES.map((value) => ({
  value,
  label: AUDIT_SUBJECT_LABELS[value],
}));

export type AuditFiltersProps = {
  values: AuditFilterValues;
  activeCount: number;
  actors: readonly Pick<User, "id" | "name">[];
  onChange: (patch: Partial<AuditFilterValues>) => void;
  onReset: () => void;
};

export function AuditFilters({
  values,
  activeCount,
  actors,
  onChange,
  onReset,
}: AuditFiltersProps) {
  const sinceId = useId();
  const actorOptions = actors.map((actor) => ({ value: actor.id, label: actor.name }));
  const knownActor = actorOptions.some((option) => option.value === values.actor);
  const options =
    values.actor === undefined || knownActor
      ? actorOptions
      : [...actorOptions, { value: values.actor, label: `User ${shortId(values.actor)}` }];

  return (
    <FilterBar<AuditFilterValues>
      label="Filter the audit log"
      fields={[]}
      values={values}
      onChange={onChange}
      onReset={onReset}
      activeCount={activeCount}
    >
      <FilterSelect
        label="Actor"
        anyLabel="Anyone"
        value={values.actor}
        options={options}
        onChange={(actor) => onChange({ actor })}
      />
      <FilterSelect
        label="Via"
        anyLabel="Any route in"
        value={values.via}
        options={VIA_OPTIONS}
        onChange={(via) => onChange({ via })}
      />
      <FilterSelect
        label="Subject type"
        anyLabel="Any subject"
        value={values.subject_type}
        options={SUBJECT_OPTIONS}
        onChange={(subject_type) => onChange({ subject_type })}
      />
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={sinceId}>Since</Label>
        <Input
          id={sinceId}
          type="date"
          value={values.since ?? ""}
          onChange={(event) =>
            onChange({ since: event.target.value === "" ? undefined : event.target.value })
          }
          className="w-44"
        />
      </div>
      {values.session === undefined ? null : (
        <Button
          type="button"
          variant="outline"
          onClick={() => onChange({ session: undefined })}
          aria-label={`Remove the filter on session ${shortId(values.session)}`}
        >
          Session {shortId(values.session)}
          <X aria-hidden="true" data-icon="inline-end" />
        </Button>
      )}
    </FilterBar>
  );
}
