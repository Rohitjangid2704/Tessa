"use client";

import { Plus, X } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { CodeEditor } from "@/components/editor/code-editor";
import type { EditorLanguage } from "@/components/editor/editor-types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { draftTextOfList, listOfDraftText } from "@/lib/schema/draft";
import type { FieldKind, FieldSpec } from "@/lib/schema/subset";

export const UNSET_OPTION_VALUE = "__schema_form_unset__";

const DEFAULT_TEXTAREA_ROWS = 4;
const DEFAULT_EDITOR_ROWS = 10;
const EDITOR_LINE_HEIGHT_PX = 19;
const EDITOR_PADDING_PX = 16;

export interface SchemaFieldProps {
  spec: FieldSpec;
  id: string;
  value: string;
  error?: string;
  disabled: boolean;
  onChange: (value: string) => void;
}

export interface WidgetProps extends SchemaFieldProps {
  describedBy: string | undefined;
}

export type SchemaWidget = (props: WidgetProps) => ReactNode;

export type SchemaWidgets = Readonly<Record<string, SchemaWidget>>;

function TextWidget({ spec, id, value, error, disabled, onChange, describedBy }: WidgetProps) {
  const inputType = spec.kind === "date" ? "date" : "text";
  const inputMode =
    spec.kind === "integer" ? "numeric" : spec.kind === "number" ? "decimal" : undefined;
  return (
    <Input
      id={id}
      name={spec.name}
      type={inputType}
      inputMode={inputMode}
      value={value}
      disabled={disabled}
      placeholder={spec.ui.placeholder}
      autoComplete="off"
      autoCapitalize="off"
      spellCheck={false}
      aria-required={spec.required}
      aria-invalid={error !== undefined}
      aria-describedby={describedBy}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

function NumberWidget({ spec, id, value, error, disabled, onChange, describedBy }: WidgetProps) {
  return (
    <Input
      id={id}
      name={spec.name}
      type="number"
      inputMode={spec.kind === "integer" ? "numeric" : "decimal"}
      min={spec.bounds.minimum}
      max={spec.bounds.maximum}
      step={spec.kind === "integer" ? 1 : "any"}
      value={value}
      disabled={disabled}
      placeholder={spec.ui.placeholder}
      autoComplete="off"
      aria-required={spec.required}
      aria-invalid={error !== undefined}
      aria-describedby={describedBy}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

function TextareaWidget({ spec, id, value, error, disabled, onChange, describedBy }: WidgetProps) {
  return (
    <Textarea
      id={id}
      name={spec.name}
      value={value}
      disabled={disabled}
      rows={spec.ui.rows ?? DEFAULT_TEXTAREA_ROWS}
      placeholder={spec.ui.placeholder}
      autoComplete="off"
      aria-required={spec.required}
      aria-invalid={error !== undefined}
      aria-describedby={describedBy}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

function ToggleWidget({ spec, id, value, disabled, onChange, describedBy }: WidgetProps) {
  const checked = value === "true";
  return (
    <div className="flex items-center gap-3">
      <Switch
        id={id}
        name={spec.name}
        checked={checked}
        disabled={disabled}
        aria-describedby={describedBy}
        onCheckedChange={(on) => onChange(on ? "true" : "false")}
      />
      <span aria-hidden="true" className="text-sm text-muted-foreground">
        {checked ? "On (true)" : "Off (false)"}
      </span>
    </div>
  );
}

function SelectWidget({ spec, id, value, error, disabled, onChange, describedBy }: WidgetProps) {
  const optional = !spec.required;
  const selectedValue = value === "" && optional ? UNSET_OPTION_VALUE : value;
  return (
    <Select
      value={selectedValue}
      disabled={disabled}
      name={spec.name}
      onValueChange={(next) => onChange(next === UNSET_OPTION_VALUE ? "" : next)}
    >
      <SelectTrigger
        id={id}
        className="w-full"
        aria-required={spec.required}
        aria-invalid={error !== undefined}
        aria-describedby={describedBy}
      >
        <SelectValue placeholder="Choose a value" />
      </SelectTrigger>
      <SelectContent position="popper" align="start">
        {optional ? <SelectItem value={UNSET_OPTION_VALUE}>Not set</SelectItem> : null}
        {spec.options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

const CHOICE_CARD_CLASS =
  "flex cursor-pointer items-start gap-3 rounded-lg border p-3 has-[:checked]:border-primary has-[:checked]:bg-primary/5 has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50 has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/50";

function ChoiceChips({ spec, id, value, disabled, onChange, describedBy }: WidgetProps) {
  return (
    <div
      id={id}
      role="radiogroup"
      aria-label={spec.label}
      aria-required={spec.required}
      aria-describedby={describedBy}
      data-slot="schema-choice-chips"
      className="grid gap-2 sm:grid-cols-2"
    >
      {spec.options.map((option) => (
        <label key={option.value} className={CHOICE_CARD_CLASS}>
          <input
            type="radio"
            name={`${id}-choice`}
            value={option.value}
            checked={value === option.value}
            disabled={disabled}
            onChange={() => onChange(option.value)}
            className="mt-0.5 size-4 shrink-0 accent-primary"
          />
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="text-sm font-medium">{option.label}</span>
            {option.description === undefined ? null : (
              <span className="text-xs text-muted-foreground">{option.description}</span>
            )}
          </span>
        </label>
      ))}
    </div>
  );
}

function OptionListChips({ spec, id, value, disabled, onChange, describedBy }: WidgetProps) {
  const selected = listOfDraftText(value);
  function toggle(optionValue: string, on: boolean): void {
    const next = on
      ? [...selected, optionValue]
      : selected.filter((item) => item !== optionValue);
    onChange(draftTextOfList(spec.options.map((option) => option.value).filter((v) => next.includes(v))));
  }
  return (
    <div
      id={id}
      role="group"
      aria-label={spec.label}
      aria-describedby={describedBy}
      data-slot="schema-option-chips"
      className="grid gap-2 sm:grid-cols-2"
    >
      {spec.options.map((option) => (
        <label key={option.value} className={CHOICE_CARD_CLASS}>
          <input
            type="checkbox"
            value={option.value}
            checked={selected.includes(option.value)}
            disabled={disabled}
            onChange={(event) => toggle(option.value, event.target.checked)}
            className="mt-0.5 size-4 shrink-0 accent-primary"
          />
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="text-sm font-medium">{option.label}</span>
            {option.description === undefined ? null : (
              <span className="text-xs text-muted-foreground">{option.description}</span>
            )}
          </span>
        </label>
      ))}
    </div>
  );
}

function FreeListChips({ spec, id, value, error, disabled, onChange, describedBy }: WidgetProps) {
  const items = listOfDraftText(value);
  const [pending, setPending] = useState("");
  const full = spec.bounds.maxItems !== undefined && items.length >= spec.bounds.maxItems;

  function addPending(): void {
    const text = pending.trim();
    if (text === "" || full) {
      return;
    }
    onChange(draftTextOfList([...items, text]));
    setPending("");
  }

  function removeAt(index: number): void {
    onChange(draftTextOfList(items.filter((_, position) => position !== index)));
  }

  return (
    <div data-slot="schema-list-chips" className="flex flex-col gap-2">
      {items.length === 0 ? null : (
        <ul aria-label={`${spec.label}, current items`} className="flex flex-wrap gap-2">
          {items.map((item, index) => (
            <li
              key={`${index}-${item}`}
              className="inline-flex items-center gap-1 rounded-4xl border py-0.5 pr-1 pl-2.5 text-xs"
            >
              <span>{item}</span>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                disabled={disabled}
                aria-label={`Remove ${item}`}
                onClick={() => removeAt(index)}
              >
                <X aria-hidden="true" />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex gap-2">
        <Input
          id={id}
          name={spec.name}
          value={pending}
          disabled={disabled || full}
          placeholder={spec.ui.placeholder ?? "Type an item and press Enter"}
          autoComplete="off"
          aria-invalid={error !== undefined}
          aria-describedby={describedBy}
          onChange={(event) => setPending(event.target.value)}
          onBlur={addPending}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              addPending();
            }
          }}
        />
        <Button
          type="button"
          variant="outline"
          disabled={disabled || full || pending.trim() === ""}
          onClick={addPending}
        >
          <Plus aria-hidden="true" data-icon="inline-start" />
          Add
        </Button>
      </div>
    </div>
  );
}

function ChipsWidget(props: WidgetProps) {
  if (props.spec.kind === "enum") {
    return <ChoiceChips {...props} />;
  }
  return props.spec.options.length > 0 ? (
    <OptionListChips {...props} />
  ) : (
    <FreeListChips {...props} />
  );
}

const EDITOR_EXTENSIONS: Record<EditorLanguage, string> = {
  yaml: "yaml",
  sql: "sql",
  python: "py",
  json: "json",
};

function editorHeight(rows: number | undefined): string {
  return `${(rows ?? DEFAULT_EDITOR_ROWS) * EDITOR_LINE_HEIGHT_PX + EDITOR_PADDING_PX}px`;
}

function EditorWidget({
  spec,
  id,
  value,
  disabled,
  onChange,
  language,
}: WidgetProps & { language: EditorLanguage }) {
  const instanceId = useId();
  return (
    <div data-slot="schema-editor" data-language={language} className="overflow-hidden rounded-lg border">
      <CodeEditor
        value={value}
        path={`inmemory://schema-form/${instanceId}-${id}.${EDITOR_EXTENSIONS[language]}`}
        ariaLabel={spec.label}
        language={language}
        readOnly={disabled}
        height={editorHeight(spec.ui.rows)}
        onChange={onChange}
      />
    </div>
  );
}

function YamlWidget(props: WidgetProps) {
  return <EditorWidget {...props} language="yaml" />;
}

function SqlWidget(props: WidgetProps) {
  return <EditorWidget {...props} language="sql" />;
}

function JsonWidget(props: WidgetProps) {
  return <EditorWidget {...props} language="json" />;
}

interface BuiltInWidget {
  kinds: readonly FieldKind[];
  render: SchemaWidget;
}

const BUILT_IN_WIDGET_TABLE: Readonly<Record<string, BuiltInWidget>> = {
  text: { kinds: ["string", "date", "integer", "number"], render: TextWidget },
  textarea: { kinds: ["string"], render: TextareaWidget },
  select: { kinds: ["enum"], render: SelectWidget },
  chips: { kinds: ["enum", "list"], render: ChipsWidget },
  number: { kinds: ["integer", "number"], render: NumberWidget },
  toggle: { kinds: ["boolean"], render: ToggleWidget },
  yaml: { kinds: ["string"], render: YamlWidget },
  sql: { kinds: ["string"], render: SqlWidget },
  json: { kinds: ["string", "object"], render: JsonWidget },
};

const DEFAULT_WIDGET_BY_KIND: Readonly<Record<FieldKind, SchemaWidget>> = {
  string: TextWidget,
  date: TextWidget,
  enum: SelectWidget,
  integer: TextWidget,
  number: TextWidget,
  boolean: ToggleWidget,
  list: ChipsWidget,
  object: JsonWidget,
};

export function resolveWidget(spec: FieldSpec, custom?: SchemaWidgets): SchemaWidget {
  const name = spec.ui.widget;
  if (name !== undefined) {
    const override = custom?.[name];
    if (override !== undefined) {
      return override;
    }
    const builtIn = BUILT_IN_WIDGET_TABLE[name];
    if (builtIn !== undefined && builtIn.kinds.includes(spec.kind)) {
      return builtIn.render;
    }
  }
  return DEFAULT_WIDGET_BY_KIND[spec.kind];
}
