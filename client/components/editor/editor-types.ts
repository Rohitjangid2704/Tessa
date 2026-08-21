export type EditorLanguage = "yaml" | "sql" | "python" | "json";

export type EditorMarkerSeverity = "error" | "warning" | "info";

export const SCHEMA_MARKER_OWNER = "yaml";

export const TESSA_MARKER_OWNER = "tessa";

export interface EditorMarker {
  severity: EditorMarkerSeverity;
  message: string;
  line: number;
  column: number;
  owner: string;
}

export interface EditorMarkerInput {
  severity: EditorMarkerSeverity;
  message: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  code?: string;
}

export type EditorSchemaState = "none" | "loading" | "ready" | "error";
