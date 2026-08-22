"use client";

import { useState } from "react";
import { CodeEditor } from "@/components/editor/code-editor";
import type { EditorMarker, EditorSchemaState } from "@/components/editor/editor-types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { clientEnv } from "@/lib/env.client";
import { INVALID_MANIFEST_SAMPLE, VALID_MANIFEST_SAMPLE } from "./samples";

const MANIFEST_PATH = "file:///tessa/manifest.yaml";
const SCHEMA_URL = `${clientEnv.NEXT_PUBLIC_API_URL}/schemas/bundle.v1.json`;

export function EditorSpike() {
  const [value, setValue] = useState(VALID_MANIFEST_SAMPLE);
  const [markers, setMarkers] = useState<EditorMarker[]>([]);
  const [schemaState, setSchemaState] = useState<EditorSchemaState>("none");

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">Editor spike</h1>
        <p className="text-sm text-muted-foreground">
          Monaco with monaco-yaml validates the manifest against{" "}
          <code className="font-mono">{SCHEMA_URL}</code>. Workers and Monaco are served from this
          origin, no CDN.
        </p>
      </header>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" variant="outline" onClick={() => setValue(VALID_MANIFEST_SAMPLE)}>
          Load valid sample
        </Button>
        <Button type="button" variant="outline" onClick={() => setValue(INVALID_MANIFEST_SAMPLE)}>
          Load invalid sample
        </Button>
        <Badge variant="secondary" data-testid="schema-status" data-state={schemaState}>
          schema: {schemaState}
        </Badge>
        <Badge
          variant={markers.length === 0 ? "secondary" : "destructive"}
          data-testid="marker-count"
          data-count={markers.length}
        >
          {markers.length} {markers.length === 1 ? "problem" : "problems"}
        </Badge>
      </div>

      <div className="overflow-hidden rounded-lg border">
        <CodeEditor
          value={value}
          path={MANIFEST_PATH}
          ariaLabel="Bundle manifest YAML"
          schemaUrl={SCHEMA_URL}
          onChange={setValue}
          onMarkersChange={setMarkers}
          onSchemaStateChange={setSchemaState}
        />
      </div>

      <section aria-live="polite" className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">Problems</h2>
        {markers.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="no-markers">
            No problems.
          </p>
        ) : (
          <ul className="flex flex-col gap-1 text-sm" data-testid="marker-list">
            {markers.map((marker) => (
              <li key={`${marker.line}:${marker.column}:${marker.message}`}>
                <span className="font-mono text-xs">
                  {marker.severity} {marker.line}:{marker.column}
                </span>{" "}
                {marker.message}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
