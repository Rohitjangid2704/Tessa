"use client";

import dynamic from "next/dynamic";
import { Skeleton } from "@/components/ui/skeleton";
import type {
  EditorLanguage,
  EditorMarker,
  EditorMarkerInput,
  EditorSchemaState,
} from "./editor-types";

export interface CodeEditorProps {
  value: string;
  path: string;
  ariaLabel: string;
  language?: EditorLanguage;
  schemaUrl?: string;
  readOnly?: boolean;
  height?: string;
  markers?: readonly EditorMarkerInput[];
  onChange?: (value: string) => void;
  onSave?: () => void;
  onMarkersChange?: (markers: EditorMarker[]) => void;
  onSchemaStateChange?: (state: EditorSchemaState) => void;
}

const DEFAULT_HEIGHT = "24rem";

const MonacoYamlEditor = dynamic(() => import("./monaco-setup"), {
  ssr: false,
  loading: () => <Skeleton className="h-full w-full" data-testid="code-editor-loading" />,
});

export function CodeEditor({ height = DEFAULT_HEIGHT, ...props }: CodeEditorProps) {
  return (
    <div style={{ height }} className="w-full">
      <MonacoYamlEditor height="100%" {...props} />
    </div>
  );
}
