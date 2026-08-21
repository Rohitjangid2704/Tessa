"use client";

import { Editor, loader, type OnMount } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import { configureMonacoYaml, type JSONSchema, type MonacoYaml } from "monaco-yaml";
import { useTheme } from "next-themes";
import { useEffect, useRef, useState } from "react";
import {
  TESSA_MARKER_OWNER,
  type EditorLanguage,
  type EditorMarker,
  type EditorMarkerInput,
  type EditorSchemaState,
} from "./editor-types";
import { defineEditorThemes, editorThemeName } from "./themes";

loader.config({ monaco });
defineEditorThemes(monaco);

globalThis.MonacoEnvironment = {
  getWorker(_moduleId, label) {
    if (label === "yaml") {
      return new Worker(new URL("monaco-yaml/yaml.worker", import.meta.url));
    }
    if (label === "json") {
      return new Worker(new URL("monaco-editor/esm/vs/language/json/json.worker", import.meta.url));
    }
    return new Worker(new URL("monaco-editor/esm/vs/editor/editor.worker", import.meta.url));
  },
};

let yamlConfiguration: MonacoYaml | null = null;

const schemaDocuments = new Map<string, Promise<JSONSchema>>();
const loadedSchemas = new Map<string, JSONSchema>();
const schemaFilePatterns = new Map<string, Set<string>>();

function loadSchema(schemaUrl: string): Promise<JSONSchema> {
  const cached = schemaDocuments.get(schemaUrl);
  if (cached !== undefined) {
    return cached;
  }
  const pending = fetch(schemaUrl).then(async (response) => {
    if (!response.ok) {
      throw new Error(`Schema request failed with ${response.status}`);
    }
    return (await response.json()) as JSONSchema;
  });
  schemaDocuments.set(schemaUrl, pending);
  pending.catch(() => schemaDocuments.delete(schemaUrl));
  return pending;
}

function filePatternOf(path: string): string {
  return `**/${path.slice(path.lastIndexOf("/") + 1)}`;
}

async function registerYamlSchema(schemaUrl: string, path: string): Promise<void> {
  const schema = await loadSchema(schemaUrl);
  loadedSchemas.set(schemaUrl, schema);
  const patterns = schemaFilePatterns.get(schemaUrl) ?? new Set<string>();
  patterns.add(filePatternOf(path));
  schemaFilePatterns.set(schemaUrl, patterns);
  const options = {
    enableSchemaRequest: false,
    validate: true,
    completion: true,
    hover: true,
    format: {},
    schemas: [...schemaFilePatterns].flatMap(([uri, fileMatch]) => {
      const loaded = loadedSchemas.get(uri);
      return loaded === undefined ? [] : [{ uri, fileMatch: [...fileMatch], schema: loaded }];
    }),
  };
  if (yamlConfiguration === null) {
    yamlConfiguration = configureMonacoYaml(monaco, options);
    return;
  }
  await yamlConfiguration.update(options);
}

function severityOf(marker: monaco.editor.IMarker): EditorMarker["severity"] {
  if (marker.severity === monaco.MarkerSeverity.Error) {
    return "error";
  }
  return marker.severity === monaco.MarkerSeverity.Warning ? "warning" : "info";
}

function toEditorMarkers(markers: monaco.editor.IMarker[]): EditorMarker[] {
  return markers.map((marker) => ({
    severity: severityOf(marker),
    message: marker.message,
    line: marker.startLineNumber,
    column: marker.startColumn,
    owner: marker.owner,
  }));
}

function monacoSeverity(severity: EditorMarkerInput["severity"]): monaco.MarkerSeverity {
  if (severity === "error") {
    return monaco.MarkerSeverity.Error;
  }
  return severity === "warning" ? monaco.MarkerSeverity.Warning : monaco.MarkerSeverity.Info;
}

function toMonacoMarker(input: EditorMarkerInput): monaco.editor.IMarkerData {
  return {
    severity: monacoSeverity(input.severity),
    message: input.message,
    code: input.code,
    source: "Tessa",
    startLineNumber: input.startLine,
    startColumn: input.startColumn,
    endLineNumber: input.endLine,
    endColumn: input.endColumn,
  };
}

const NO_MARKERS: readonly EditorMarkerInput[] = [];

export interface MonacoYamlEditorProps {
  value: string;
  path: string;
  language?: EditorLanguage;
  schemaUrl?: string;
  readOnly?: boolean;
  ariaLabel: string;
  height: string;
  markers?: readonly EditorMarkerInput[];
  onChange?: (value: string) => void;
  onSave?: () => void;
  onMarkersChange?: (markers: EditorMarker[]) => void;
  onSchemaStateChange?: (state: EditorSchemaState) => void;
}

export default function MonacoYamlEditor({
  value,
  path,
  language = "yaml",
  schemaUrl,
  readOnly = false,
  ariaLabel,
  height,
  markers = NO_MARKERS,
  onChange,
  onSave,
  onMarkersChange,
  onSchemaStateChange,
}: MonacoYamlEditorProps) {
  const { resolvedTheme } = useTheme();
  const [mountedEditor, setMountedEditor] = useState(false);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const saveRef = useRef(onSave);

  useEffect(() => {
    saveRef.current = onSave;
  }, [onSave]);

  useEffect(() => {
    const model = editorRef.current?.getModel();
    if (!mountedEditor || model === null || model === undefined) {
      return;
    }
    monaco.editor.setModelMarkers(model, TESSA_MARKER_OWNER, markers.map(toMonacoMarker));
  }, [mountedEditor, markers, path]);

  const handleMount: OnMount = (editor) => {
    editorRef.current = editor;
    editor.updateOptions({ ariaLabel });
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveRef.current?.());
    setMountedEditor(true);
    if (schemaUrl === undefined) {
      onSchemaStateChange?.("none");
      return;
    }
    onSchemaStateChange?.("loading");
    registerYamlSchema(schemaUrl, path).then(
      () => onSchemaStateChange?.("ready"),
      () => onSchemaStateChange?.("error"),
    );
  };

  return (
    <div data-testid="code-editor" data-mounted={mountedEditor} className="h-full">
      <Editor
        height={height}
        language={language}
        path={path}
        value={value}
        theme={editorThemeName(resolvedTheme)}
        options={{
          readOnly,
          tabFocusMode: readOnly,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          automaticLayout: true,
          tabSize: 2,
          fontSize: 13,
        }}
        onMount={handleMount}
        onChange={(next) => onChange?.(next ?? "")}
        onValidate={(found) => onMarkersChange?.(toEditorMarkers(found))}
      />
    </div>
  );
}
