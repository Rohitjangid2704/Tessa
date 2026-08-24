"use client";

import { useQueryClient } from "@tanstack/react-query";
import { Info, LoaderCircle, Save, TriangleAlert, Undo2 } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { CodeEditor } from "@/components/editor/code-editor";
import {
  SCHEMA_MARKER_OWNER,
  type EditorMarker,
  type EditorMarkerInput,
  type EditorSchemaState,
} from "@/components/editor/editor-types";
import { issuesToMarkers } from "@/components/editor/markers";
import { readRequestId } from "@/components/states/request-id";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { describeApiError } from "@/lib/api/errors";
import type { Scenario, ScenarioVersion } from "@/lib/api/types";
import { useCan } from "@/lib/auth/can";
import { isVersionConflict, useSaveScenario } from "../mutations";
import { scenarioQuery } from "../queries";
import { SCENARIO_SCHEMA_URL } from "../schemas";
import { useScenarioValidation } from "../use-scenario-validation";
import { useUnsavedGuard } from "../use-unsaved-guard";
import { ConflictDialog } from "./conflict-dialog";
import { UnsavedGuardDialog } from "./unsaved-guard-dialog";
import { ValidationPanel } from "./validation-panel";
import { VersionsPanel } from "./versions-panel";

const EDITOR_HEIGHT = "32rem";

const NO_MARKERS: readonly EditorMarkerInput[] = [];

const SCHEMA_STATE_LABELS = {
  none: "Schema not used",
  loading: "Loading the schema",
  ready: "Schema checks on",
  error: "Schema offline",
} as const satisfies Record<EditorSchemaState, string>;

interface EditSession {
  draft: string;
  baseVersion: number;
}

export type ScenarioEditorProps = {
  scenario: Scenario;
  aside?: ReactNode;
};

export function ScenarioEditor({ scenario, aside }: ScenarioEditorProps) {
  const queryClient = useQueryClient();
  const canEdit = useCan("scenarios.edit");
  const save = useSaveScenario(scenario.id);
  const [session, setSession] = useState<EditSession | null>(null);
  const [schemaState, setSchemaState] = useState<EditorSchemaState>("none");
  const [editorMarkers, setEditorMarkers] = useState<EditorMarker[]>([]);
  const [conflict, setConflict] = useState<Scenario | null>(null);
  const [conflictLoadError, setConflictLoadError] = useState<unknown>(null);

  const retired = scenario.status === "retired";
  const readOnly = !canEdit || retired;
  const value = session?.draft ?? scenario.yaml;
  const dirtySession = session !== null && session.draft !== scenario.yaml ? session : null;
  const dirty = dirtySession !== null;
  const guard = useUnsavedGuard(dirty);

  const server = useScenarioValidation({
    targetId: scenario.target_id,
    yaml: value,
    enabled: !retired,
  });
  const schemaMarkers = editorMarkers.filter((marker) => marker.owner === SCHEMA_MARKER_OWNER);
  const schemaErrorCount = schemaMarkers.filter((marker) => marker.severity === "error").length;

  const serverMarkers = useMemo<readonly EditorMarkerInput[]>(() => {
    if (server.validation === null) {
      return NO_MARKERS;
    }
    return [
      ...issuesToMarkers(server.validation.errors, value, "error"),
      ...issuesToMarkers(server.validation.warnings, value, "warning"),
    ];
  }, [server.validation, value]);

  const blockedBySchema = schemaErrorCount > 0;
  const canSave = !readOnly && dirty && !blockedBySchema && !save.isPending;

  function change(next: string): void {
    if (readOnly) {
      return;
    }
    save.reset();
    setSession((previous) =>
      next === scenario.yaml
        ? null
        : { draft: next, baseVersion: previous?.baseVersion ?? scenario.version },
    );
  }

  async function openConflict(): Promise<void> {
    try {
      const theirs = await queryClient.fetchQuery({ ...scenarioQuery(scenario.id), staleTime: 0 });
      setConflictLoadError(null);
      setConflict(theirs);
    } catch (error) {
      setConflictLoadError(error);
    }
  }

  function handleSave(): void {
    if (!canSave || session === null) {
      return;
    }
    setConflictLoadError(null);
    save.mutate(
      { yaml: session.draft, baseVersion: session.baseVersion },
      {
        onSuccess: (saved) => {
          setSession(null);
          toast.success(`Saved version ${saved.version}`);
        },
        onError: (error) => {
          if (isVersionConflict(error)) {
            void openConflict();
          }
        },
      },
    );
  }

  function reload(): void {
    setSession(null);
    setConflict(null);
    save.reset();
  }

  function rebase(): void {
    const rebasedOnto = conflict?.version;
    setSession((previous) =>
      previous === null || rebasedOnto === undefined
        ? previous
        : { draft: previous.draft, baseVersion: rebasedOnto },
    );
    setConflict(null);
    save.reset();
    if (rebasedOnto !== undefined) {
      toast.info(`Rebased onto version ${rebasedOnto}. Press Save to keep your text.`);
    }
  }

  function restore(version: ScenarioVersion): void {
    change(version.yaml);
    toast.info(`Version ${version.version} is in the editor. Press Save to keep it.`);
  }

  function discard(): void {
    setSession(null);
    save.reset();
  }

  let saveHint: string | null = null;
  if (retired) {
    saveHint = "This scenario is retired and read-only.";
  } else if (!canEdit) {
    saveHint = "Viewers can read scenarios but not edit them.";
  } else if (blockedBySchema) {
    saveHint = `Fix ${schemaErrorCount} schema ${schemaErrorCount === 1 ? "error" : "errors"} to save.`;
  } else if (!dirty) {
    saveHint = "No unsaved changes.";
  }

  const saveFailure = save.isError && !isVersionConflict(save.error) ? save.error : null;

  return (
    <div
      data-slot="scenario-editor"
      data-dirty={dirty}
      data-schema-state={schemaState}
      className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(16rem,22rem)]"
    >
      <div className="flex min-w-0 flex-col gap-4">
        {readOnly ? (
          <Alert role="note" data-slot="scenario-read-only">
            <Info aria-hidden="true" />
            <AlertTitle>Read-only</AlertTitle>
            <AlertDescription>
              {retired
                ? "This scenario is retired. Its YAML and versions stay available to read."
                : "You have the viewer role, so you can read this scenario but not change it."}
            </AlertDescription>
          </Alert>
        ) : null}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-semibold">Scenario YAML</h2>
            {dirtySession !== null ? (
              <Badge variant="secondary" data-slot="unsaved-badge">
                Unsaved changes, based on version {dirtySession.baseVersion}
              </Badge>
            ) : (
              <Badge variant="outline">Version {scenario.version}</Badge>
            )}
            <span className="text-xs text-muted-foreground">
              {SCHEMA_STATE_LABELS[schemaState]}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {dirty && !readOnly ? (
              <Button type="button" variant="ghost" size="sm" onClick={discard}>
                <Undo2 aria-hidden="true" data-icon="inline-start" />
                Discard changes
              </Button>
            ) : null}
            <Button
              type="button"
              disabled={!canSave}
              aria-busy={save.isPending}
              aria-keyshortcuts="Control+S"
              onClick={handleSave}
            >
              {save.isPending ? (
                <LoaderCircle aria-hidden="true" data-icon="inline-start" className="animate-spin" />
              ) : (
                <Save aria-hidden="true" data-icon="inline-start" />
              )}
              {save.isPending ? "Saving" : "Save"}
              <Kbd aria-hidden="true">Ctrl S</Kbd>
            </Button>
          </div>
        </div>
        {saveHint === null || readOnly ? null : (
          <p role="status" className="text-sm text-muted-foreground">
            {saveHint}
          </p>
        )}
        {saveFailure === null ? null : (
          <Alert variant="destructive" role="alert" data-slot="scenario-save-error">
            <TriangleAlert aria-hidden="true" />
            <AlertTitle>The scenario was not saved</AlertTitle>
            <AlertDescription>
              {describeApiError(saveFailure)}
              {readRequestId(saveFailure) === null ? null : (
                <span className="block font-mono text-xs">
                  Request ID: {readRequestId(saveFailure)}
                </span>
              )}
            </AlertDescription>
          </Alert>
        )}
        {conflictLoadError === null ? null : (
          <Alert variant="destructive" role="alert" data-slot="scenario-conflict-error">
            <TriangleAlert aria-hidden="true" />
            <AlertTitle>Someone saved a newer version</AlertTitle>
            <AlertDescription>
              Their version could not be loaded to compare: {describeApiError(conflictLoadError)}{" "}
              Press Save to try again. Your text is still in the editor.
            </AlertDescription>
          </Alert>
        )}
        <div className="overflow-hidden rounded-lg border">
          <CodeEditor
            value={value}
            path={`inmemory://scenario-editor/${scenario.id}.yaml`}
            ariaLabel="Scenario YAML editor"
            language="yaml"
            schemaUrl={SCENARIO_SCHEMA_URL}
            readOnly={readOnly}
            height={EDITOR_HEIGHT}
            markers={serverMarkers}
            onChange={change}
            onSave={handleSave}
            onMarkersChange={setEditorMarkers}
            onSchemaStateChange={setSchemaState}
          />
        </div>
        <p className="text-xs text-muted-foreground">
          Press <Kbd>Ctrl M</Kbd> (<Kbd>Ctrl Shift M</Kbd> on macOS) to let the Tab key move focus
          out of the editor.
        </p>
        <ValidationPanel
          yaml={value}
          schemaMarkers={schemaMarkers}
          schemaState={schemaState}
          server={server}
        />
      </div>
      <div className="flex min-w-0 flex-col gap-6">
        <VersionsPanel
          scenarioId={scenario.id}
          currentVersion={scenario.version}
          currentYaml={scenario.yaml}
          canRestore={!readOnly}
          onRestore={restore}
        />
        {aside}
      </div>
      <ConflictDialog
        theirs={conflict}
        mine={session?.draft ?? ""}
        onReload={reload}
        onRebase={rebase}
        onKeepEditing={() => setConflict(null)}
      />
      <UnsavedGuardDialog guard={guard} />
    </div>
  );
}
