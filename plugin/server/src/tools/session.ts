import { z } from "zod";
import { unwrap, unwrapOptional } from "../client";
import { defineTool } from "./define";
import { summariseEnvironment } from "./environment";

export const whoami = defineTool({
  name: "whoami",
  title: "Who am I",
  description:
    "Read. Shows the Tessa user the personal token belongs to (name, email, role), the token prefix, the API URL and the Claude Code agent session id. Call it first to confirm the connection.",
  access: "read",
  input: {},
  async handler(context) {
    const user = await unwrap(context.api.client.GET("/api/v1/users/me"));
    return {
      user: { id: user.id, name: user.name, email: user.email, role: user.role },
      token_prefix: context.tokenPrefix,
      api_url: context.api.baseUrl,
      agent_session_id: context.session.state.id ?? null,
      selected_target_id: context.session.state.targetId ?? null,
    };
  },
});

export const listTargets = defineTool({
  name: "list_targets",
  title: "List targets",
  description:
    "Read. Lists the targets the user can see: id, name, slug, tier (qa or production), app kind, latest bundle version, completeness score and health. Production targets are read-only for the loop.",
  access: "read",
  input: {
    query: z.string().max(200).optional().describe("Name or slug contains"),
    include_archived: z.boolean().optional(),
    limit: z.number().int().min(1).max(200).optional().describe("Page size, default 50"),
  },
  async handler(context, args) {
    const page = await unwrap(
      context.api.client.GET("/api/v1/targets", {
        params: {
          query: {
            q: args.query,
            include_archived: args.include_archived,
            limit: args.limit ?? 50,
          },
        },
      }),
    );
    return {
      targets: page.items.map((target) => ({
        id: target.id,
        name: target.name,
        slug: target.slug,
        tier: target.tier,
        app_kind: target.app_kind,
        latest_bundle_version: target.latest_bundle_version,
        completeness_score: target.completeness_score,
        health: target.health,
        archived: target.archived_at !== null && target.archived_at !== undefined,
      })),
      has_more: page.next_cursor !== null,
    };
  },
});

export const getTarget = defineTool({
  name: "get_target",
  title: "Get target",
  description:
    "Read. One target with its latest bundle summary, the environment variable names with has_value and health (never values) and the proposal summary when there is one. Also makes this target the one the agent session works on.",
  access: "read",
  input: {
    target_id: z.string().uuid(),
  },
  async handler(context, args) {
    const path = { target_id: args.target_id };
    const [target, bundles, environment, proposal] = await Promise.all([
      unwrap(context.api.client.GET("/api/v1/targets/{target_id}", { params: { path } })),
      unwrap(
        context.api.client.GET("/api/v1/targets/{target_id}/bundles", {
          params: { path, query: { limit: 1 } },
        }),
      ),
      unwrap(context.api.client.GET("/api/v1/targets/{target_id}/environment", { params: { path } })),
      unwrapOptional(context.api.client.GET("/api/v1/targets/{target_id}/proposal", { params: { path } })),
    ]);
    await context.session.selectTarget({ id: target.id, target_token: target.target_token });
    const statusCounts: Record<string, number> = {};
    for (const item of proposal?.items ?? []) {
      statusCounts[item.status] = (statusCounts[item.status] ?? 0) + 1;
    }
    return {
      target: {
        id: target.id,
        name: target.name,
        slug: target.slug,
        tier: target.tier,
        app_kind: target.app_kind,
        allow_production: target.allow_production,
        target_token: target.target_token,
        created_at: target.created_at,
        archived: target.archived_at !== null && target.archived_at !== undefined,
      },
      production: target.tier === "production",
      latest_bundle: bundles.items[0] ?? null,
      environment: summariseEnvironment(environment),
      proposal: proposal
        ? {
            id: proposal.id,
            generated_at: proposal.generated_at,
            commit_sha: proposal.commit_sha,
            branch: proposal.branch,
            stale: proposal.stale,
            item_count: proposal.items.length,
            status_counts: statusCounts,
          }
        : null,
    };
  },
});
