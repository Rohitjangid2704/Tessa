"use client";

import { Check } from "lucide-react";
import { useEffect, useId, useState, type KeyboardEvent } from "react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { TargetTier } from "../types";
import { TierChip } from "./tier-chip";

export interface TargetComboboxOption {
  id: string;
  name: string;
  tier: TargetTier;
  archived?: boolean;
}

export interface TargetListboxProps {
  options: readonly TargetComboboxOption[];
  selectedIds: readonly string[];
  multiple: boolean;
  onPick: (targetId: string) => void;
  label: string;
  disabledIds?: readonly string[];
}

export function filterTargetOptions<Option extends Pick<TargetComboboxOption, "name">>(
  options: readonly Option[],
  query: string,
): Option[] {
  const needle = query.trim().toLowerCase();
  return needle === ""
    ? [...options]
    : options.filter((option) => option.name.toLowerCase().includes(needle));
}

function optionDomId(baseId: string, targetId: string): string {
  return `${baseId}-option-${targetId}`;
}

function neighbourId(
  options: readonly TargetComboboxOption[],
  activeId: string | null,
  step: number,
): string | null {
  if (options.length === 0) {
    return null;
  }
  const index = options.findIndex((option) => option.id === activeId);
  const origin = index < 0 ? (step > 0 ? -1 : 0) : index;
  return options[(origin + step + options.length) % options.length]?.id ?? null;
}

export function TargetListbox({
  options,
  selectedIds,
  multiple,
  onPick,
  label,
  disabledIds = [],
}: TargetListboxProps) {
  const baseId = useId();
  const listboxId = `${baseId}-listbox`;
  const [query, setQuery] = useState("");
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const visible = filterTargetOptions(options, query);
  const activeId =
    visible.find((option) => option.id === highlightedId)?.id ?? visible[0]?.id ?? null;

  useEffect(() => {
    if (activeId !== null) {
      document.getElementById(optionDomId(baseId, activeId))?.scrollIntoView?.({ block: "nearest" });
    }
  }, [activeId, baseId]);

  function pick(targetId: string): void {
    if (!disabledIds.includes(targetId)) {
      onPick(targetId);
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setHighlightedId(neighbourId(visible, activeId, 1));
        break;
      case "ArrowUp":
        event.preventDefault();
        setHighlightedId(neighbourId(visible, activeId, -1));
        break;
      case "Home":
        event.preventDefault();
        setHighlightedId(visible[0]?.id ?? null);
        break;
      case "End":
        event.preventDefault();
        setHighlightedId(visible.at(-1)?.id ?? null);
        break;
      case "Enter":
        event.preventDefault();
        if (activeId !== null) {
          pick(activeId);
        }
        break;
      default:
        break;
    }
  }

  return (
    <div data-slot="target-listbox" className="flex flex-col gap-1">
      <div className="p-2 pb-1">
        <Input
          type="text"
          role="combobox"
          aria-label="Search targets"
          aria-expanded="true"
          aria-autocomplete="list"
          aria-controls={visible.length === 0 ? undefined : listboxId}
          aria-activedescendant={activeId === null ? undefined : optionDomId(baseId, activeId)}
          autoComplete="off"
          spellCheck={false}
          placeholder="Search targets"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={handleKeyDown}
        />
      </div>
      <p role="status" className="sr-only">
        {visible.length === 1 ? "1 target" : `${visible.length} targets`}
      </p>
      {visible.length === 0 ? (
        <p className="px-3 py-4 text-center text-sm text-muted-foreground">
          {options.length === 0 ? "No targets to choose from." : "No target matches the search."}
        </p>
      ) : (
        <ul
          id={listboxId}
          role="listbox"
          aria-label={label}
          aria-multiselectable={multiple ? true : undefined}
          className="max-h-64 overflow-y-auto p-1"
        >
          {visible.map((option) => {
            const selected = selectedIds.includes(option.id);
            const disabled = disabledIds.includes(option.id);
            return (
              <li
                key={option.id}
                id={optionDomId(baseId, option.id)}
                role="option"
                tabIndex={-1}
                aria-selected={selected}
                aria-disabled={disabled ? true : undefined}
                data-active={option.id === activeId ? "true" : undefined}
                data-target-id={option.id}
                onMouseDown={(event) => event.preventDefault()}
                onMouseMove={() => setHighlightedId(option.id)}
                onClick={() => pick(option.id)}
                className={cn(
                  "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm",
                  option.id === activeId && "bg-accent text-accent-foreground",
                  disabled && "cursor-not-allowed opacity-50",
                )}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    "flex size-4 shrink-0 items-center justify-center border",
                    multiple ? "rounded-sm" : "rounded-full border-transparent",
                    selected && multiple && "border-primary bg-primary text-primary-foreground",
                    !multiple && "text-foreground",
                  )}
                >
                  {selected ? <Check className="size-3" /> : null}
                </span>
                <span className="min-w-0 flex-1 truncate">{option.name}</span>
                {option.archived ? <Badge variant="outline">Archived</Badge> : null}
                <TierChip tier={option.tier} />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
