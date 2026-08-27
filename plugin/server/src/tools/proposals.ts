import { lstat, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { LineCounter, parseDocument } from "yaml";
import { z } from "zod";
import { unwrap, unwrapOptional } from "../client";
import { cutValue } from "../cut";
import { ApiError, localError, type ApiErrorDetail } from "../errors";
import { validateAgainstSchema } from "../jsonschema";
import { plain } from "../redact";
import type { Schemas } from "../types";
import { asList } from "./args";
import { defineTool, type ToolContext } from "./define";

type Proposal = Schemas["Proposal"];
type ProposalItem = Schemas["ProposalItem"];

const ITEM_STATUSES = ["proposed", "selected", "declined", "authored", "covered"] as const;
const ITEM_CHOICES = ["proposed", "selected", "declined"] as const;
const ITEMS_BUDGET_BYTES = 45_000;
const REASON_NOTE_BYTES = 160;
const EVIDENCE_BYTES = 200;
const MAX_PROPOSAL_BYTES = 262_144;
const PROPOSAL_FILE = "proposal.yaml";
const BUNDLE_FOLDER = "tessa";
const LOCAL_ISSUE_LIMIT = 50;
const WARNING_LIMIT = 100;

const schemaCache = new WeakMap<object, Promise<Record<string, unknown> | null>>();

function countBy<Item>(items: readonly Item[], pick: (item: Item) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const name = pick(item);
    counts[name] = (counts[name] ?? 0) + 1;
  }
  return counts;
}

function summariseItem(item: ProposalItem, keysOnly: boolean) {
  const base = {
    id: item.id,
    key: plain(item.key),
    title: item.title,
    area: item.area,
    risk: item.risk,
    status: item.status,
    cell_count: item.cell_ids.length,
  };
  if (keysOnly) {
    return base;
  }
  return {
    ...base,
    kind: item.kind,
    depth: item.depth,
    confidence: item.confidence,
    note: item.note,
    feature_ids: item.feature_ids,
    interface_id: item.interface_id,
    reasons: item.reasons.map((reason) => ({
      code: reason.code,
      note: reason.note ? (cutValue(reason.note, REASON_NOTE_BYTES).value as string) : null,
    })),
    needs: item.needs,
    estimate: item.estimate,
    evidence: item.evidence ? (cutValue(item.evidence, EVIDENCE_BYTES).value as string) : null,
    scenario_count: item.scenario_ids.length,
    selected_by: item.selected_by,
    selected_at: item.selected_at,
  };
}

function fitItems(items: ProposalItem[], keysOnly: boolean) {
  const kept: Array<ReturnType<typeof summariseItem>> = [];
  let bytes = 0;
  for (const item of items) {
    const summary = summariseItem(item, keysOnly);
    const size = Buffer.byteLength(JSON.stringify(summary));
    if (bytes + size > ITEMS_BUDGET_BYTES) {
      break;
    }
    bytes += size;
    kept.push(summary);
  }
  return { items: kept, truncated: kept.length < items.length };
}

export function summariseProposal(
  proposal: Proposal,
  options: { status?: string[]; area?: string; keysOnly?: boolean } = {},
) {
  const wanted = options.status === undefined ? null : new Set(options.status);
  const selected = proposal.items.filter(
    (item) => (wanted === null || wanted.has(item.status)) && (options.area === undefined || item.area === options.area),
  );
  const fitted = fitItems(selected, options.keysOnly ?? false);
  return {
    id: proposal.id,
    target_id: proposal.target_id,
    bundle_id: proposal.bundle_id,
    commit_sha: proposal.commit_sha,
    branch: proposal.branch,
    generated_at: proposal.generated_at,
    source: proposal.source,
    created_by: proposal.created_by,
    created_at: proposal.created_at,
    stale: proposal.stale,
    item_count: proposal.items.length,
    status_counts: countBy(proposal.items, (item) => item.status),
    risk_counts: countBy(proposal.items, (item) => item.risk),
    items_matching: selected.length,
    items: fitted.items,
    items_truncated: fitted.truncated,
  };
}

export const getProposal = defineTool({
  name: "get_proposal",
  title: "Get proposal",
  description:
    "Read. The current test proposal of a target, or { proposal: null } when it has none. Returns generated_at, commit and branch, source (bundle or put), stale (a newer valid bundle exists), counts per status and risk, and the items: id, key, title, area, kind, risk, status (proposed, selected, declined, authored or covered), reasons, needs, estimate, cell_count and scenario_count. Filter by status or area; keys_only returns just id, key, title, area, risk and status for all items. Keep the keys of earlier items when you propose again.",
  access: "read",
  input: {
    target_id: z.string().uuid(),
    status: z.union([z.enum(ITEM_STATUSES), z.array(z.enum(ITEM_STATUSES)).min(1)]).optional(),
    area: z.string().min(1).max(120).optional(),
    keys_only: z.boolean().optional(),
  },
  async handler(context, args) {
    const proposal = await unwrapOptional(
      context.api.client.GET("/api/v1/targets/{target_id}/proposal", {
        params: { path: { target_id: args.target_id } },
      }),
    );
    if (proposal === undefined) {
      return { proposal: null };
    }
    return {
      proposal: summariseProposal(proposal, {
        status: asList(args.status),
        area: args.area,
        keysOnly: args.keys_only,
      }),
    };
  },
});

export const updateProposalItem = defineTool({
  name: "update_proposal_item",
  title: "Update proposal item",
  description:
    "Write. Ticks (selected), declines (declined) or resets (proposed) one item of the current proposal, with an optional note of at most 300 characters. Call it only when the user said which item to tick or decline. authored and covered are set by Tessa. A 409 means the item belongs to an older proposal or is already authored.",
  access: "write",
  idempotent: true,
  input: {
    item_id: z.string().uuid(),
    status: z.enum(ITEM_CHOICES),
    note: z.string().max(300).optional(),
  },
  async handler(context, args) {
    const item = await unwrap(
      context.api.client.PATCH("/api/v1/proposal-items/{item_id}", {
        params: { path: { item_id: args.item_id } },
        body: { status: args.status, note: args.note ?? null },
      }),
    );
    return { item: summariseItem(item, false) };
  },
});

export const planFromProposal = defineTool({
  name: "plan_from_proposal",
  title: "Plan from proposal",
  description:
    "Write (free; spends nothing until the plan is run). Saves a plan that covers the selected items of the current proposal, or exactly item_ids. Returns the plan id, name, cell count and budget. A 422 with detail code nothing_selected means no item is ticked.",
  access: "write",
  idempotent: false,
  input: {
    target_id: z.string().uuid(),
    name: z.string().min(1).max(120).optional(),
    item_ids: z.array(z.string().uuid()).min(1).max(200).optional(),
  },
  async handler(context, args) {
    const plan = await unwrap(
      context.api.client.POST("/api/v1/targets/{target_id}/proposal/plan", {
        params: { path: { target_id: args.target_id }, header: { "Idempotency-Key": context.generateId() } },
        body: { name: args.name ?? null, item_ids: args.item_ids ?? null },
      }),
    );
    return {
      plan: {
        id: plan.id,
        target_id: plan.target_id,
        bundle_id: plan.bundle_id,
        name: plan.name,
        saved: plan.saved,
        cells_total: plan.cells_total,
        include_api_fuzz: plan.include_api_fuzz,
        selection: cutValue(plan.selection, 4000).value,
        effective_budget: plan.effective_budget,
        created_at: plan.created_at,
      },
    };
  },
});

async function readProposalFile(input: string): Promise<{ file: string; text: string }> {
  const given = resolve(input);
  const candidates = [join(given, BUNDLE_FOLDER, PROPOSAL_FILE), join(given, PROPOSAL_FILE), given];
  for (const candidate of candidates) {
    let info;
    try {
      info = await lstat(candidate);
    } catch {
      continue;
    }
    if (info.isSymbolicLink()) {
      throw localError("symlink_refused", `${candidate} is a symbolic link`);
    }
    if (!info.isFile() || !candidate.endsWith(PROPOSAL_FILE)) {
      continue;
    }
    if (info.size > MAX_PROPOSAL_BYTES) {
      throw localError("proposal_too_large", `${PROPOSAL_FILE} is larger than ${MAX_PROPOSAL_BYTES} bytes`);
    }
    return { file: candidate, text: await readFile(candidate, "utf8") };
  }
  throw localError(
    "proposal_not_found",
    `No ${BUNDLE_FOLDER}/${PROPOSAL_FILE} found at ${input}; write it first or pass the repository folder`,
  );
}

function loadSchema(context: ToolContext): Promise<Record<string, unknown> | null> {
  let pending = schemaCache.get(context.api);
  if (pending === undefined) {
    pending = unwrap(
      context.api.client.GET("/schemas/{name}.v{version}.json", {
        params: { path: { name: "proposal", version: 1 } },
      }),
    )
      .then((schema) => schema as unknown as Record<string, unknown>)
      .catch((error: unknown) => {
        schemaCache.delete(context.api);
        if (error instanceof ApiError && error.status === 404) {
          return null;
        }
        throw error;
      });
    schemaCache.set(context.api, pending);
  }
  return pending;
}

type Parsed = { value: unknown; lineOf: (path: Array<string | number>) => number | null };

function parseProposalText(text: string): Parsed {
  const lineCounter = new LineCounter();
  const document = parseDocument(text, { lineCounter });
  if (document.errors.length > 0) {
    const details: ApiErrorDetail[] = document.errors.slice(0, LOCAL_ISSUE_LIMIT).map((error) => {
      const line = error.linePos?.[0]?.line;
      return {
        code: error.code,
        message: line === undefined ? error.message : `line ${line}: ${error.message}`,
        loc: [],
      };
    });
    throw localError("proposal_yaml_invalid", `${PROPOSAL_FILE} is not valid YAML`, details);
  }
  const lineOf = (path: Array<string | number>): number | null => {
    for (let length = path.length; length >= 0; length -= 1) {
      const node = document.getIn(path.slice(0, length), true) as { range?: [number, number, number] } | undefined;
      if (node?.range !== undefined) {
        return lineCounter.linePos(node.range[0]).line;
      }
    }
    return null;
  };
  return { value: document.toJS(), lineOf };
}

function checkAgainstSchema(schema: Record<string, unknown>, parsed: Parsed): ApiErrorDetail[] {
  const issues = validateAgainstSchema(schema, parsed.value, LOCAL_ISSUE_LIMIT);
  const details = issues.map((issue) => {
    const line = parsed.lineOf(issue.path);
    const where = issue.pointer === "" ? "the document" : issue.pointer;
    return {
      code: "schema",
      message: `${line === null ? "" : `line ${line}: `}${where} ${issue.message}`,
      loc: issue.path,
    };
  });
  const value = parsed.value as { items?: unknown };
  if (Array.isArray(value?.items)) {
    const seen = new Map<string, number>();
    value.items.forEach((item: unknown, index: number) => {
      const key = (item as { key?: unknown } | null)?.key;
      if (typeof key !== "string") {
        return;
      }
      if (seen.has(key)) {
        details.push({
          code: "duplicate_key",
          message: `line ${parsed.lineOf(["items", index, "key"]) ?? "?"}: /items/${index}/key repeats the key of item ${seen.get(key)}`,
          loc: ["items", index, "key"],
        });
      } else {
        seen.set(key, index);
      }
    });
  }
  return details;
}

function documentTargetToken(value: unknown): string | null {
  const token = (value as { target_token?: unknown } | null)?.target_token;
  return typeof token === "string" ? token : null;
}

function derivedWarnings(proposal: Proposal, sent: unknown) {
  const sentItems = Array.isArray((sent as { items?: unknown })?.items) ? ((sent as { items: unknown[] }).items) : [];
  const sentConfidence = new Map<string, string>();
  for (const entry of sentItems) {
    const record = entry as { key?: unknown; confidence?: unknown };
    if (typeof record.key === "string" && typeof record.confidence === "string") {
      sentConfidence.set(record.key, record.confidence);
    }
  }
  const warnings: Array<{ key: string; code: string; message: string }> = [];
  for (const item of proposal.items) {
    const before = sentConfidence.get(item.key);
    if (before !== undefined && before !== item.confidence) {
      warnings.push({
        key: item.key,
        code: "confidence_lowered",
        message: `Tessa changed confidence from ${before} to ${item.confidence}; a feature or interface id of this item is not in the latest bundle`,
      });
    }
    if (item.cell_ids.length === 0) {
      warnings.push({
        key: item.key,
        code: "no_cells",
        message: "The item maps to no coverage cell of the latest bundle, so ticking it cannot lead to a plan",
      });
    }
  }
  return warnings.slice(0, WARNING_LIMIT).map((warning) => ({ ...warning, key: plain(warning.key) }));
}

export const putProposal = defineTool({
  name: "put_proposal",
  title: "Put proposal",
  description:
    "Write. Reads tessa/proposal.yaml from the folder at path (the repository folder, the tessa folder or the file), checks it locally against the published proposal.v1.json schema, then stores it as the current proposal of the target. Returns the stored proposal and warnings derived from it. Ticks and notes carry over to items that keep their key. Local problems come back with a line number and a JSON pointer; nothing is sent until the file is clean.",
  access: "write",
  idempotent: true,
  input: {
    path: z.string().min(1).describe("Repository folder that contains tessa/proposal.yaml"),
    target_id: z.string().uuid().optional().describe("Defaults to the target selected with get_target"),
  },
  async handler(context, args) {
    const { text } = await readProposalFile(args.path);
    const parsed = parseProposalText(text);
    const targetId = args.target_id ?? context.session.state.targetId;
    if (targetId === undefined) {
      throw localError("target_required", "Pass target_id or call get_target first so the session has a target");
    }
    const knownToken = context.session.state.targetToken;
    const documentToken = documentTargetToken(parsed.value);
    if (
      targetId === context.session.state.targetId &&
      knownToken !== undefined &&
      documentToken !== null &&
      documentToken !== knownToken
    ) {
      throw localError(
        "target_mismatch",
        "The target_token in tessa/proposal.yaml is not the token of the selected target",
      );
    }
    const schema = await loadSchema(context);
    if (schema !== null) {
      const problems = checkAgainstSchema(schema, parsed);
      if (problems.length > 0) {
        throw localError(
          "proposal_invalid_local",
          `${PROPOSAL_FILE} has ${problems.length} problem${problems.length === 1 ? "" : "s"}; fix them and call again`,
          problems,
        );
      }
    }
    const proposal = await unwrap(
      context.api.client.PUT("/api/v1/targets/{target_id}/proposal", {
        params: { path: { target_id: targetId } },
        body: { yaml: text },
      }),
    );
    return {
      local_validation: schema === null ? "skipped_schema_not_published" : "passed",
      proposal: summariseProposal(proposal),
      warnings: derivedWarnings(proposal, parsed.value),
    };
  },
});
