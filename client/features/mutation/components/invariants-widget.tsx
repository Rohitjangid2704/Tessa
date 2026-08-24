"use client";

import { useQuery } from "@tanstack/react-query";
import type { WidgetProps } from "@/components/schema-form";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { INVARIANT_PACK_LABELS, INVARIANT_PACKS } from "@/features/invariants/labels";
import { invariantCatalogQuery } from "@/features/invariants/queries";
import { draftTextOfList, listOfDraftText } from "@/lib/schema/draft";

const LIST_SEPARATOR = /[\s,]+/;

function parseTypedIds(text: string): string[] {
  return [...new Set(text.split(LIST_SEPARATOR).filter((entry) => entry !== ""))];
}

export function InvariantsWidget({
  spec,
  id,
  value,
  error,
  disabled,
  onChange,
  describedBy,
}: WidgetProps) {
  const catalog = useQuery(invariantCatalogQuery());
  const selected = listOfDraftText(value);

  if (catalog.isPending) {
    return (
      <div role="status" aria-busy="true" className="flex flex-col gap-2">
        <span className="sr-only">Loading the invariants</span>
        <Skeleton className="h-5 w-64 max-w-full" />
        <Skeleton className="h-5 w-56 max-w-full" />
      </div>
    );
  }

  if (catalog.isError) {
    return (
      <div className="flex flex-col gap-1">
        <Input
          id={id}
          name={spec.name}
          value={selected.join(", ")}
          disabled={disabled}
          placeholder="tenant_isolation, count_consistency"
          autoComplete="off"
          spellCheck={false}
          aria-invalid={error !== undefined}
          aria-describedby={describedBy}
          onChange={(event) => onChange(draftTextOfList(parseTypedIds(event.target.value)))}
        />
        <p role="note" className="text-xs text-muted-foreground">
          The invariant list could not be loaded, so type the ids separated by commas.
        </p>
      </div>
    );
  }

  const invariants = catalog.data;
  const knownIds = new Set(invariants.map((invariant) => invariant.id));
  const unknownSelected = selected.filter((entry) => !knownIds.has(entry));

  function toggle(invariantId: string, checked: boolean): void {
    const wanted = checked
      ? new Set([...selected, invariantId])
      : new Set(selected.filter((entry) => entry !== invariantId));
    const ordered = [
      ...invariants.map((invariant) => invariant.id).filter((entry) => wanted.has(entry)),
      ...[...wanted].filter((entry) => !knownIds.has(entry)),
    ];
    onChange(draftTextOfList(ordered));
  }

  return (
    <div
      id={id}
      role="group"
      aria-label={spec.label}
      aria-describedby={describedBy}
      data-slot="invariants-widget"
      className="flex max-h-72 flex-col gap-3 overflow-y-auto rounded-lg border p-3"
    >
      {INVARIANT_PACKS.map((pack) => {
        const inPack = invariants.filter((invariant) => invariant.pack === pack);
        if (inPack.length === 0) {
          return null;
        }
        return (
          <fieldset key={pack} className="flex flex-col gap-2" disabled={disabled}>
            <legend className="mb-1 text-xs font-medium text-muted-foreground">
              {INVARIANT_PACK_LABELS[pack]}
            </legend>
            {inPack.map((invariant) => {
              const inputId = `${id}-${invariant.id}`;
              return (
                <div key={invariant.id} className="flex items-start gap-2">
                  <Checkbox
                    id={inputId}
                    checked={selected.includes(invariant.id)}
                    onCheckedChange={(checked) => toggle(invariant.id, checked === true)}
                    className="mt-0.5"
                  />
                  <Label htmlFor={inputId} className="flex flex-col items-start gap-0 font-normal">
                    <span>{invariant.title}</span>
                    <span className="font-mono text-xs text-muted-foreground">{invariant.id}</span>
                  </Label>
                </div>
              );
            })}
          </fieldset>
        );
      })}
      {unknownSelected.length === 0 ? null : (
        <fieldset className="flex flex-col gap-2" disabled={disabled}>
          <legend className="mb-1 text-xs font-medium text-muted-foreground">Not in the catalog</legend>
          {unknownSelected.map((invariantId) => {
            const inputId = `${id}-${invariantId}`;
            return (
              <div key={invariantId} className="flex items-start gap-2">
                <Checkbox
                  id={inputId}
                  checked
                  onCheckedChange={() => toggle(invariantId, false)}
                  className="mt-0.5"
                />
                <Label htmlFor={inputId} className="font-mono text-xs font-normal">
                  {invariantId}
                </Label>
              </div>
            );
          })}
        </fieldset>
      )}
    </div>
  );
}
