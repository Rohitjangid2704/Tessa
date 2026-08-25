import { http } from "msw";
import { conflict, notFound, validationFailed } from "../factories/errors";
import { newId } from "../factories/ids";
import type { PromptIssue } from "../factories/prompts";
import { nowIso } from "../factories/targets";
import { parseJsonObject } from "../factories/validation";
import { findTemplate } from "../fixtures/prompt-templates";
import { BodyReader } from "../stage1/body";
import { renderHooks, renderMutants } from "../stage1/render-prompt";
import { hashParts, pathUuid, requireTarget, stageOne, withIdempotency } from "../stage1/support";
import { INVARIANT_CATALOG, invariantInfo } from "../stage5/invariant-catalog";
import { api, requireUser, type ApiContext } from "./api";

type MutationPromptName = "mutants" | "hooks";

const MAX_INVARIANT_IDS = 50;

function promptNameOf(rawText: string): MutationPromptName | null {
  try {
    const parsed: unknown = JSON.parse(rawText);
    if (typeof parsed !== "object" || parsed === null || !("template_name" in parsed)) {
      return null;
    }
    return parsed.template_name === "mutants" || parsed.template_name === "hooks"
      ? parsed.template_name
      : null;
  } catch {
    return null;
  }
}

function readInvariantIds(reader: BodyReader): string[] {
  const requested = reader.stringList("invariant_ids", { maxItems: MAX_INVARIANT_IDS });
  if (requested === undefined) {
    reader.issue("invariant_ids", "missing", "Field required");
    return [];
  }
  if (requested === null || requested.length === 0) {
    reader.issue(
      "invariant_ids",
      "too_short",
      "List should have at least 1 item after validation, not 0",
    );
    return [];
  }
  const unique = [...new Set(requested)];
  unique.forEach((id, index) => {
    if (invariantInfo(id) === undefined) {
      reader.details.push({
        loc: ["body", "mutants", "invariant_ids", index],
        code: "unknown_invariant",
        message: `Unknown invariant '${id}'`,
      });
    }
  });
  return unique;
}

async function createMutationPromptIssue(
  context: ApiContext,
  name: MutationPromptName,
  rawText: string,
): Promise<Response> {
  const user = await requireUser(context, "member");
  const targetId = pathUuid(context, "target_id");
  const reader = new BodyReader(parseJsonObject(rawText), ["body", name]);
  const invariantIds = name === "mutants" ? readInvariantIds(reader) : [];
  const bundleId = name === "hooks" ? reader.uuid("bundle_id", { required: true }) : undefined;
  if (reader.details.length > 0) {
    throw validationFailed(reader.details);
  }
  return withIdempotency(
    context,
    user,
    { required: false, requestHash: hashParts("POST", context.url.pathname, rawText) },
    () => {
      const target = requireTarget(context, targetId);
      if (target.archivedAt !== null) {
        throw conflict("conflict", "The target is archived");
      }
      const template = findTemplate(name, null);
      if (template === null) {
        throw notFound("Prompt template not found");
      }
      let text: string;
      let params: Record<string, unknown>;
      if (name === "mutants") {
        const invariants = INVARIANT_CATALOG.filter((entry) => invariantIds.includes(entry.id));
        text = renderMutants({ template, target, invariants, origin: context.url.origin });
        params = { template_name: "mutants", invariant_ids: invariantIds };
      } else {
        const record = bundleId == null ? undefined : stageOne(context).findBundle(bundleId);
        if (record === undefined || record.bundle.target_id !== target.id) {
          throw notFound("Bundle not found for this target");
        }
        text = renderHooks({ template, target, record });
        params = { template_name: "hooks", bundle_id: record.bundle.id };
      }
      const issue: PromptIssue = {
        id: newId(),
        target_id: target.id,
        template_name: name,
        template_version: template.version,
        target_token: target.targetToken,
        text,
        params,
        issued_by: user.id,
        issued_at: nowIso(),
      };
      stageOne(context).promptIssues.push(issue);
      return { status: 201, body: issue };
    },
  );
}

const resolveMutationPrompt = (name: MutationPromptName, rawText: string) =>
  api((context) => createMutationPromptIssue(context, name, rawText));

export const mutationPromptHandlers = [
  http.post("*/api/v1/targets/:target_id/prompt-issues", async (info) => {
    const rawText = await info.request.clone().text();
    const name = promptNameOf(rawText);
    if (name === null) {
      return undefined;
    }
    return resolveMutationPrompt(name, rawText)(info);
  }),
];
