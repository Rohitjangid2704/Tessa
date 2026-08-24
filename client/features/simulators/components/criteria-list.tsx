"use client";

import { Plus, X } from "lucide-react";
import type { WidgetProps } from "@/components/schema-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { draftTextOfList, listOfDraftText } from "@/lib/schema/draft";
import {
  CRITERION_KINDS,
  CRITERION_PREFIXES,
  DEFAULT_CRITERION_PREFIX,
  formatCriterion,
  infoOfPrefix,
  isCompleteCriterion,
  parseCriterion,
  type CriterionPrefix,
} from "../criteria";

function isPrefix(value: string): value is CriterionPrefix {
  return (CRITERION_PREFIXES as readonly string[]).includes(value);
}

export function CriteriaList({ spec, id, value, error, disabled, onChange, describedBy }: WidgetProps) {
  const entries = listOfDraftText(value);
  const maxItems = spec.bounds.maxItems;
  const full = maxItems !== undefined && entries.length >= maxItems;

  function replaceAt(index: number, entry: string): void {
    onChange(draftTextOfList(entries.map((current, position) => (position === index ? entry : current))));
  }

  function removeAt(index: number): void {
    onChange(draftTextOfList(entries.filter((_, position) => position !== index)));
  }

  function addRow(): void {
    onChange(draftTextOfList([...entries, formatCriterion(DEFAULT_CRITERION_PREFIX, "")]));
  }

  return (
    <div data-slot="criteria-list" className="flex flex-col gap-3">
      {entries.length === 0 ? (
        <p id={id} className="text-sm text-muted-foreground">
          No criteria yet. Add at least one so the run can decide whether the goal was reached.
        </p>
      ) : (
        <ul id={id} aria-describedby={describedBy} className="flex flex-col gap-3">
          {entries.map((entry, index) => {
            const parsed = parseCriterion(entry);
            const info = infoOfPrefix(parsed.prefix);
            return (
              <li
                key={index}
                data-prefix={parsed.prefix}
                className="flex flex-col gap-1.5 rounded-lg border p-2.5"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Select
                    value={parsed.prefix}
                    disabled={disabled}
                    onValueChange={(prefix) => {
                      if (isPrefix(prefix)) {
                        replaceAt(index, formatCriterion(prefix, parsed.text));
                      }
                    }}
                  >
                    <SelectTrigger aria-label={`Type of criterion ${index + 1}`} className="w-44">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent position="popper" align="start">
                      {CRITERION_KINDS.map((kind) => (
                        <SelectItem key={kind.prefix} value={kind.prefix}>
                          {kind.label} ({kind.prefix}:)
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Input
                    aria-label={`Criterion ${index + 1}`}
                    value={parsed.text}
                    disabled={disabled}
                    placeholder={info.placeholder}
                    autoComplete="off"
                    aria-invalid={error !== undefined && !isCompleteCriterion(entry)}
                    className="min-w-48 flex-1"
                    onChange={(event) => replaceAt(index, formatCriterion(parsed.prefix, event.target.value))}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    disabled={disabled}
                    aria-label={`Remove criterion ${index + 1}`}
                    onClick={() => removeAt(index)}
                  >
                    <X aria-hidden="true" />
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Decided by {info.decidedBy === "code" ? "code" : "the judge"}. {info.hint}
                </p>
              </li>
            );
          })}
        </ul>
      )}
      <div>
        <Button type="button" variant="outline" disabled={disabled || full} onClick={addRow}>
          <Plus aria-hidden="true" data-icon="inline-start" />
          Add criterion
        </Button>
      </div>
    </div>
  );
}
