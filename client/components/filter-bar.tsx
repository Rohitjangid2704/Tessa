"use client";

import { ChevronDown, X } from "lucide-react";
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

export const DEFAULT_TEXT_DEBOUNCE_MS = 250;

export interface FilterOption {
  value: string;
  label: string;
}

export type FilterField<Key extends string = string> =
  | { type: "text"; key: Key; label: string; placeholder?: string; debounceMs?: number }
  | { type: "multi"; key: Key; label: string; options: readonly FilterOption[] }
  | { type: "toggle"; key: Key; label: string };

export interface FilterBarProps<Values extends object> {
  label: string;
  fields: readonly FilterField<Extract<keyof Values, string>>[];
  values: Partial<Values>;
  onChange: (patch: Partial<Values>) => void;
  onReset?: () => void;
  activeCount?: number;
  className?: string;
  children?: ReactNode;
}

function patchFor<Values extends object>(key: string, value: unknown): Partial<Values> {
  return { [key]: value } as Partial<Values>;
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

interface TextFilterProps {
  field: Extract<FilterField, { type: "text" }>;
  committed: string;
  onCommit: (value: string) => void;
}

function TextFilter({ field, committed, onCommit }: TextFilterProps) {
  const inputId = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const delay = field.debounceMs ?? DEFAULT_TEXT_DEBOUNCE_MS;

  useEffect(
    () => () => {
      if (timer.current !== null) {
        clearTimeout(timer.current);
      }
    },
    [],
  );

  function commit(value: string): void {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    setDraft(null);
    onCommit(value);
  }

  function change(value: string): void {
    setDraft(value);
    if (timer.current !== null) {
      clearTimeout(timer.current);
    }
    timer.current = setTimeout(() => commit(value), delay);
  }

  return (
    <div className="flex min-w-48 flex-1 flex-col gap-1.5">
      <Label htmlFor={inputId}>{field.label}</Label>
      <Input
        id={inputId}
        type="search"
        autoComplete="off"
        value={draft ?? committed}
        placeholder={field.placeholder}
        onChange={(event) => change(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit(event.currentTarget.value);
          }
        }}
      />
    </div>
  );
}

interface MultiFilterProps {
  field: Extract<FilterField, { type: "multi" }>;
  selected: readonly string[];
  onChange: (next: string[]) => void;
}

function MultiFilter({ field, selected, onChange }: MultiFilterProps) {
  const groupId = useId();
  const summary = selected.length === 0 ? "any" : `${selected.length} selected`;

  function toggle(value: string, checked: boolean): void {
    const next = checked ? [...selected, value] : selected.filter((item) => item !== value);
    onChange(field.options.map((option) => option.value).filter((item) => next.includes(item)));
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" aria-label={`${field.label}: ${summary}`}>
          {field.label}
          {selected.length > 0 ? <Badge variant="secondary">{selected.length}</Badge> : null}
          <ChevronDown aria-hidden="true" data-icon="inline-end" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64">
        <div role="group" aria-label={field.label} className="flex flex-col gap-2">
          {field.options.length === 0 ? (
            <p className="text-sm text-muted-foreground">No options</p>
          ) : null}
          {field.options.map((option) => {
            const optionId = `${groupId}-${option.value}`;
            return (
              <div key={option.value} className="flex items-center gap-2">
                <Checkbox
                  id={optionId}
                  checked={selected.includes(option.value)}
                  onCheckedChange={(checked) => toggle(option.value, checked === true)}
                />
                <Label htmlFor={optionId} className="font-normal">
                  {option.label}
                </Label>
              </div>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}

interface ToggleFilterProps {
  field: Extract<FilterField, { type: "toggle" }>;
  checked: boolean;
  onChange: (next: boolean) => void;
}

function ToggleFilter({ field, checked, onChange }: ToggleFilterProps) {
  const switchId = useId();
  return (
    <div className="flex items-center gap-2 self-end pb-1.5">
      <Switch id={switchId} checked={checked} onCheckedChange={onChange} />
      <Label htmlFor={switchId} className="font-normal">
        {field.label}
      </Label>
    </div>
  );
}

export function FilterBar<Values extends object>({
  label,
  fields,
  values,
  onChange,
  onReset,
  activeCount = 0,
  className,
  children,
}: FilterBarProps<Values>) {
  const [resetCount, setResetCount] = useState(0);

  function reset(): void {
    setResetCount((count) => count + 1);
    onReset?.();
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
  }

  return (
    <form
      role="search"
      aria-label={label}
      data-slot="filter-bar"
      onSubmit={handleSubmit}
      className={cn("flex flex-wrap items-end gap-3", className)}
    >
      {fields.map((field) => {
        const current: unknown = Reflect.get(values, field.key);
        if (field.type === "text") {
          return (
            <TextFilter
              key={`${field.key}-${resetCount}`}
              field={field}
              committed={asText(current)}
              onCommit={(value) =>
                onChange(patchFor<Values>(field.key, value === "" ? undefined : value))
              }
            />
          );
        }
        if (field.type === "multi") {
          const selected = asList(current);
          return (
            <MultiFilter
              key={field.key}
              field={field}
              selected={selected}
              onChange={(next) =>
                onChange(patchFor<Values>(field.key, next.length === 0 ? undefined : next))
              }
            />
          );
        }
        return (
          <ToggleFilter
            key={field.key}
            field={field}
            checked={current === true}
            onChange={(next) => onChange(patchFor<Values>(field.key, next ? true : undefined))}
          />
        );
      })}
      {children}
      {onReset && activeCount > 0 ? (
        <Button type="button" variant="ghost" onClick={reset}>
          <X aria-hidden="true" data-icon="inline-start" />
          Clear filters
        </Button>
      ) : null}
      <p role="status" className="sr-only">
        {activeCount === 0
          ? "No filters active"
          : `${activeCount} ${activeCount === 1 ? "filter" : "filters"} active`}
      </p>
    </form>
  );
}
