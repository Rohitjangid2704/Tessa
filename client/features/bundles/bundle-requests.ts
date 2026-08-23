import type createClient from "openapi-fetch";
import type { components } from "@/lib/api/schema";
import type { MergedApiPaths } from "@/lib/api/types";
import { unwrap } from "@/lib/api/unwrap";

export type BundleUploadResult = components["schemas"]["BundleUploadResult"];
export type IntakeClient = ReturnType<typeof createClient<MergedApiPaths>>;

export const ZIP_MEDIA_TYPE = "application/zip";
export const NOTE_MAX_LENGTH = 500;

export interface UploadBundleInput {
  file: File;
  targetId: string;
  note: string;
  idempotencyKey: string;
}

export interface PasteManifestInput {
  manifestYaml: string;
  targetId: string;
  note: string;
  idempotencyKey: string;
}

export function trimmedNote(note: string): string | null {
  const trimmed = note.trim();
  return trimmed === "" ? null : trimmed;
}

export function buildUploadFormData(input: UploadBundleInput): FormData {
  const form = new FormData();
  form.set("file", new File([input.file], input.file.name, { type: ZIP_MEDIA_TYPE }));
  form.set("target_id", input.targetId);
  const note = trimmedNote(input.note);
  if (note !== null) {
    form.set("note", note);
  }
  return form;
}

export function uploadBundleRequest(
  client: IntakeClient,
  input: UploadBundleInput,
): Promise<BundleUploadResult> {
  const form = buildUploadFormData(input);
  return unwrap(
    client.POST("/api/v1/bundles", {
      params: { header: { "Idempotency-Key": input.idempotencyKey } },
      body: { file: input.file.name, target_id: input.targetId },
      bodySerializer: () => form,
    }),
  );
}

export function pasteManifestRequest(
  client: IntakeClient,
  input: PasteManifestInput,
): Promise<BundleUploadResult> {
  return unwrap(
    client.POST("/api/v1/bundles/paste", {
      params: { header: { "Idempotency-Key": input.idempotencyKey } },
      body: {
        manifest_yaml: input.manifestYaml,
        target_id: input.targetId,
        note: trimmedNote(input.note),
      },
    }),
  );
}
