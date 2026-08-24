"use client";

import { useQuery } from "@tanstack/react-query";
import { CodeView } from "@/components/code-view";
import { CopyButton } from "@/components/copy-button";
import type { EditorLanguage } from "@/components/editor/editor-types";
import { readRequestId } from "@/components/states/request-id";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { describeApiError, isApiError } from "@/lib/api/errors";
import { NO_RESET_SCRIPT_REASON } from "../gates";
import { resetScriptQuery } from "../queries";
import type { Seed } from "../types";

export type ScriptSeed = Pick<
  Seed,
  | "bundle_id"
  | "reset_script_path"
  | "has_reset_script"
  | "hash_command"
  | "has_hash_command"
  | "material_sha256"
>;

const LANGUAGE_BY_EXTENSION: Record<string, EditorLanguage> = {
  sql: "sql",
  py: "python",
  json: "json",
  yaml: "yaml",
  yml: "yaml",
};

export function languageOfPath(path: string): EditorLanguage | null {
  const extension = path.split(".").at(-1)?.toLowerCase() ?? "";
  return LANGUAGE_BY_EXTENSION[extension] ?? null;
}

function PlainText({ text, label }: { text: string; label: string }) {
  return (
    <div
      role="region"
      aria-label={label}
      tabIndex={0}
      className="max-h-64 overflow-auto rounded-lg border bg-muted/40 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
    >
      <pre
        data-slot="script-text"
        className="p-3 font-mono text-xs break-words whitespace-pre-wrap"
      >
        {text}
      </pre>
    </div>
  );
}

interface ResetScriptProps {
  seed: ScriptSeed & { reset_script_path: string };
  plain: boolean;
}

function ResetScript({ seed, plain }: ResetScriptProps) {
  const file = useQuery(resetScriptQuery(seed.bundle_id, seed.reset_script_path));
  const label = `Reset script ${seed.reset_script_path}`;

  if (file.isPending) {
    return (
      <div role="status" aria-busy="true" className="flex flex-col gap-2">
        <span className="sr-only">Loading the reset script</span>
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  if (file.isError) {
    const missing = isApiError(file.error) && file.error.status === 404;
    return (
      <Alert variant="destructive" data-slot="script-error">
        <AlertTitle>
          {missing ? "The bundle has no such file" : "Could not load the reset script"}
        </AlertTitle>
        <AlertDescription>
          <p>
            {missing
              ? `${seed.reset_script_path} is not in the bundle of this seed version.`
              : describeApiError(file.error)}
            {readRequestId(file.error) === null ? null : ` Request ID: ${readRequestId(file.error)}`}
          </p>
          {missing ? null : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-2"
              onClick={() => void file.refetch()}
            >
              Try again
            </Button>
          )}
        </AlertDescription>
      </Alert>
    );
  }

  const language = languageOfPath(seed.reset_script_path);
  return (
    <div className="flex flex-col gap-2">
      {file.data.truncated ? (
        <p role="note" data-slot="script-truncated" className="text-xs text-muted-foreground">
          The file is large, so only its first part is shown.
        </p>
      ) : null}
      {plain || language === null ? (
        <PlainText text={file.data.content} label={label} />
      ) : (
        <CodeView value={file.data.content} language={language} label={label} />
      )}
    </div>
  );
}

export interface ScriptPreviewProps {
  seed: ScriptSeed;
  variant?: "editor" | "plain";
  className?: string;
}

export function ScriptPreview({ seed, variant = "editor", className }: ScriptPreviewProps) {
  const plain = variant === "plain";
  return (
    <section
      data-slot="script-preview"
      aria-label="Seed scripts"
      className={className ?? "flex min-w-0 flex-col gap-4"}
    >
      <div className="flex min-w-0 flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold">Reset script</h3>
          {seed.reset_script_path === null ? null : (
            <code className="font-mono text-xs break-all text-muted-foreground">
              {seed.reset_script_path}
            </code>
          )}
        </div>
        {seed.reset_script_path === null || !seed.has_reset_script ? (
          <p
            data-slot="no-reset-script"
            className="rounded-lg border border-dashed px-3 py-3 text-sm text-muted-foreground"
          >
            {NO_RESET_SCRIPT_REASON}
          </p>
        ) : (
          <ResetScript seed={{ ...seed, reset_script_path: seed.reset_script_path }} plain={plain} />
        )}
      </div>
      <div className="flex min-w-0 flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold">Hash command</h3>
          {seed.hash_command === null ? null : (
            <CopyButton
              text={seed.hash_command}
              subject="hash command"
              variant="ghost"
              size="xs"
            />
          )}
        </div>
        {seed.hash_command === null || !seed.has_hash_command ? (
          <p
            data-slot="no-hash-command"
            className="rounded-lg border border-dashed px-3 py-3 text-sm text-muted-foreground"
          >
            The manifest has no hash command, so this seed cannot be verified.
          </p>
        ) : (
          <PlainText text={seed.hash_command} label="Hash command" />
        )}
      </div>
      <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>Material sha256</span>
        <code data-slot="material-sha256" className="font-mono break-all">
          {seed.material_sha256}
        </code>
      </p>
    </section>
  );
}
