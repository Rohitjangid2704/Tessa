import { http } from "msw";
import { notFound, validationFailed } from "../factories/errors";
import { newId } from "../factories/ids";
import type { PromptIssue } from "../factories/prompts";
import { nowIso } from "../factories/targets";
import { parseJsonObject } from "../factories/validation";
import { BodyReader } from "../stage1/body";
import { hashParts, pathUuid, requireTarget, stageOne, withIdempotency } from "../stage1/support";
import { AUTHOR_TEMPLATE_VERSION, renderAuthorPrompt } from "../stage6/author-prompt";
import type { CoverageCellState } from "../stage6/coverage-data";
import { coverageStore } from "../stage6/coverage-store";
import type { ErrorDetail } from "../types";
import { api, requireUser, type ApiContext } from "./api";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function isAuthorBody(rawText: string): boolean {
  try {
    const parsed: unknown = JSON.parse(rawText);
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      "template_name" in parsed &&
      parsed.template_name === "author"
    );
  } catch {
    return false;
  }
}

async function createAuthorIssue(context: ApiContext): Promise<Response> {
  const user = await requireUser(context, "member");
  const targetId = pathUuid(context, "target_id");
  const rawText = await context.request.text();
  const reader = new BodyReader(parseJsonObject(rawText), ["body", "author"]);
  const requested = reader.stringList("cell_ids", {});
  if (requested === undefined) {
    reader.issue("cell_ids", "missing", "Field required");
  }
  if (reader.details.length > 0) {
    throw validationFailed(reader.details);
  }
  const cellIds = [...new Set((requested ?? []).map((id) => id.toLowerCase()))];
  const details: ErrorDetail[] = [];
  if (cellIds.length === 0) {
    details.push({
      loc: ["body", "author", "cell_ids"],
      code: "too_short",
      message: "List should have at least 1 item after validation, not 0",
    });
  }
  const cells: CoverageCellState[] = [];
  cellIds.forEach((id, index) => {
    const located = UUID_PATTERN.test(id) ? coverageStore.findCell(id) : undefined;
    if (located === undefined || located.dataset.targetId !== targetId) {
      details.push({
        loc: ["body", "author", "cell_ids", index],
        code: "unknown_cell",
        message: `Cell ${id} does not belong to this target`,
      });
    } else {
      cells.push(located.cell);
    }
  });
  if (details.length > 0) {
    throw validationFailed(details);
  }
  return withIdempotency(
    context,
    user,
    { required: false, requestHash: hashParts("POST", context.url.pathname, rawText) },
    () => {
      const target = requireTarget(context, targetId);
      if (target.archivedAt !== null) {
        throw notFound("Target not found");
      }
      const issue: PromptIssue = {
        id: newId(),
        target_id: target.id,
        template_name: "author",
        template_version: AUTHOR_TEMPLATE_VERSION,
        target_token: target.targetToken,
        text: renderAuthorPrompt(target, cells, context.url.origin),
        params: { template_name: "author", cell_ids: cellIds },
        issued_by: user.id,
        issued_at: nowIso(),
      };
      stageOne(context).promptIssues.push(issue);
      return { status: 201, body: issue };
    },
  );
}

const resolveAuthorIssue = api(createAuthorIssue);

export const authorPromptHandlers = [
  http.post("*/api/v1/targets/:target_id/prompt-issues", async (info) => {
    if (!isAuthorBody(await info.request.clone().text())) {
      return undefined;
    }
    return resolveAuthorIssue(info);
  }),
];
