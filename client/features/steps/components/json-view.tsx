"use client";

import { ChevronRight } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { CopyButton } from "@/components/copy-button";
import { Button } from "@/components/ui/button";
import { formatCount } from "@/features/steps/format";
import { cn } from "@/lib/utils";

export const JSON_STRING_LIMIT = 400;
export const JSON_PAGE_SIZE = 50;
export const JSON_DEFAULT_OPEN_DEPTH = 2;

export function stringifyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? "undefined";
  } catch {
    return String(value);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function containerEntries(value: unknown): [string, unknown][] {
  if (Array.isArray(value)) {
    return value.map((item, index): [string, unknown] => [String(index), item]);
  }
  return isRecord(value) ? Object.entries(value) : [];
}

function isNonEmptyContainer(value: unknown): boolean {
  return containerEntries(value).length > 0;
}

function KeyLabel({ name }: { name: string | null }) {
  if (name === null) {
    return null;
  }
  return <span className="mr-1 text-muted-foreground">{name}:</span>;
}

function JsonString({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const isCut = text.length > JSON_STRING_LIMIT;
  const shown = isCut && !expanded ? `${text.slice(0, JSON_STRING_LIMIT)}...` : text;
  return (
    <span className="wrap-anywhere whitespace-pre-wrap">
      {JSON.stringify(shown)}
      {isCut ? (
        <Button
          type="button"
          variant="link"
          size="xs"
          onClick={() => setExpanded((current) => !current)}
          className="ml-1 h-auto p-0 text-xs"
        >
          {expanded ? "Show less" : `Show all ${formatCount(text.length)} characters`}
        </Button>
      ) : null}
    </span>
  );
}

function JsonLeaf({ name, value }: { name: string | null; value: unknown }) {
  let rendered: ReactNode;
  if (typeof value === "string") {
    rendered = <JsonString text={value} />;
  } else if (Array.isArray(value)) {
    rendered = "[]";
  } else if (isRecord(value)) {
    rendered = "{}";
  } else {
    rendered = String(value);
  }
  return (
    <div data-slot="json-leaf" className="flex min-w-0 flex-wrap">
      <KeyLabel name={name} />
      <span className="min-w-0">{rendered}</span>
    </div>
  );
}

interface NodeProps {
  name: string | null;
  value: unknown;
  depth: number;
  openDepth: number;
}

function JsonContainer({ name, value, depth, openDepth }: NodeProps) {
  const [isOpen, setIsOpen] = useState(depth < openDepth);
  const [visible, setVisible] = useState(JSON_PAGE_SIZE);
  const entries = containerEntries(value);
  const isArray = Array.isArray(value);
  const count = entries.length;
  const noun = isArray ? (count === 1 ? "item" : "items") : count === 1 ? "key" : "keys";
  const shown = entries.slice(0, visible);
  const hidden = count - shown.length;

  return (
    <details
      open={isOpen}
      onToggle={(event) => setIsOpen(event.currentTarget.open)}
      data-slot="json-container"
      className="group min-w-0"
    >
      <summary className="flex cursor-pointer list-none items-center gap-1 rounded-sm marker:hidden focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none [&::-webkit-details-marker]:hidden">
        <ChevronRight
          aria-hidden="true"
          className="size-3 shrink-0 transition-transform group-open:rotate-90 motion-reduce:transition-none"
        />
        <KeyLabel name={name} />
        <span className="text-muted-foreground">
          {isArray ? `[${count} ${noun}]` : `{${count} ${noun}}`}
        </span>
      </summary>
      {isOpen ? (
        <div className="mt-0.5 ml-1.5 flex flex-col gap-0.5 border-l pl-3">
          {shown.map(([key, child]) => (
            <JsonNode key={key} name={key} value={child} depth={depth + 1} openDepth={openDepth} />
          ))}
          {hidden > 0 ? (
            <Button
              type="button"
              variant="link"
              size="xs"
              onClick={() => setVisible((current) => current + JSON_PAGE_SIZE)}
              className="h-auto self-start p-0 text-xs"
            >
              {`Show ${formatCount(Math.min(hidden, JSON_PAGE_SIZE))} more of ${formatCount(hidden)} hidden`}
            </Button>
          ) : null}
        </div>
      ) : null}
    </details>
  );
}

function JsonNode(props: NodeProps) {
  if (isNonEmptyContainer(props.value)) {
    return <JsonContainer {...props} />;
  }
  return <JsonLeaf name={props.name} value={props.value} />;
}

export interface JsonViewProps {
  value: unknown;
  label: string;
  defaultOpenDepth?: number;
  className?: string;
}

export function JsonView({
  value,
  label,
  defaultOpenDepth = JSON_DEFAULT_OPEN_DEPTH,
  className,
}: JsonViewProps) {
  const [expandAll, setExpandAll] = useState(false);
  const text = useMemo(() => stringifyJson(value), [value]);

  return (
    <div
      role="group"
      aria-label={label}
      data-slot="json-view"
      className={cn("flex min-w-0 flex-col gap-1", className)}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        <div className="flex items-center gap-1">
          {isNonEmptyContainer(value) ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => setExpandAll((current) => !current)}
            >
              {expandAll ? "Collapse all" : "Expand all"}
            </Button>
          ) : null}
          <CopyButton text={text} subject={label} variant="ghost" size="xs" />
        </div>
      </div>
      <div
        tabIndex={0}
        className="max-h-96 overflow-auto rounded-md border bg-muted/40 px-3 py-2 font-mono text-xs"
      >
        <JsonNode
          key={expandAll ? "expanded" : "collapsed"}
          name={null}
          value={value}
          depth={0}
          openDepth={expandAll ? Number.POSITIVE_INFINITY : defaultOpenDepth}
        />
      </div>
    </div>
  );
}
