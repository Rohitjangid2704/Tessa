"use client";

import { useId } from "react";
import { CodeEditor } from "@/components/editor/code-editor";
import type { EditorLanguage } from "@/components/editor/editor-types";
import { cn } from "@/lib/utils";

export interface CodeViewProps {
  value: string;
  language: EditorLanguage;
  label: string;
  className?: string;
}

const FILE_EXTENSIONS: Record<EditorLanguage, string> = {
  yaml: "yaml",
  sql: "sql",
  python: "py",
  json: "json",
};

const LINE_HEIGHT_PX = 19;
const VERTICAL_PADDING_PX = 16;
const MIN_HEIGHT_PX = 120;
const MAX_HEIGHT_PX = 420;

export function codeViewHeight(value: string): string {
  const lines = value.split("\n").length;
  const wanted = lines * LINE_HEIGHT_PX + VERTICAL_PADDING_PX;
  return `${Math.min(MAX_HEIGHT_PX, Math.max(MIN_HEIGHT_PX, wanted))}px`;
}

export function CodeView({ value, language, label, className }: CodeViewProps) {
  const instanceId = useId();
  const path = `inmemory://code-view/${instanceId}.${FILE_EXTENSIONS[language]}`;
  return (
    <div
      data-slot="code-view"
      data-language={language}
      className={cn("overflow-hidden rounded-lg border", className)}
    >
      <CodeEditor
        value={value}
        path={path}
        language={language}
        ariaLabel={label}
        readOnly
        height={codeViewHeight(value)}
      />
    </div>
  );
}
