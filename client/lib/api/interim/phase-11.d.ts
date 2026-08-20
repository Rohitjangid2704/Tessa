import type { components as Known } from "../schema";

export interface paths {
  "/api/v1/agent-sessions": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** Claude Code sessions that talked to Tessa, newest first */
    get: operations["agent_sessions_list_agent_sessions"];
    put?: never;
    /** A Claude Code session announces itself; a second call with the id of a session that is still open returns that session with status 200 */
    post: operations["agent_sessions_create_agent_session"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/agent-sessions/{agent_session_id}": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    /** Move the session to another target, end it or leave a summary; only the owner may change a session */
    patch: operations["agent_sessions_update_agent_session"];
    trace?: never;
  };
  "/api/v1/audit-events": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** The audit log, newest first: administration changes and every write made with a personal token */
    get: operations["audit_list_audit_events"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/bundles/validate": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** Validate, score and diff a bundle zip and list everything that is open, storing nothing */
    post: operations["bundles_validate_bundle_upload"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/proposal-items/{item_id}": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    /** Tick, decline or reset an item of the current proposal; authored and covered are set by Tessa and cannot be sent */
    patch: operations["proposals_update_proposal_item"];
    trace?: never;
  };
  "/api/v1/targets/{target_id}/proposal": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** The current test proposal of a target, with the cells each item maps to; 404 when the target has none */
    get: operations["proposals_read_proposal"];
    /** Store a test proposal from the content of tessa/proposal.yaml; ticks, notes and authored scenarios carry over to items that keep their key */
    put: operations["proposals_put_proposal"];
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/targets/{target_id}/proposal/plan": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** Save a plan that covers the selected items of the current proposal, or the items named in item_ids */
    post: operations["proposals_plan_from_proposal"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/users/me/tokens": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** Personal tokens of the caller, newest first, with their state */
    get: operations["personal_tokens_list_my_tokens"];
    put?: never;
    /** Create a personal token for Claude Code; the token is shown once and sends no Idempotency-Key because the response holds a secret */
    post: operations["personal_tokens_create_my_token"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/users/me/tokens/{token_id}": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post?: never;
    /** Revoke one of the caller's personal tokens; revoking twice is not an error */
    delete: operations["personal_tokens_revoke_my_token"];
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/users/{user_id}/tokens": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** Personal tokens of a user, for administrators */
    get: operations["personal_tokens_list_user_tokens"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/users/{user_id}/tokens/{token_id}": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post?: never;
    /** Revoke a personal token of any user, for administrators */
    delete: operations["personal_tokens_revoke_user_token"];
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
}

export type webhooks = Record<string, never>;

export interface components {
  schemas: {
    AuthorPromptProposalFields: {
      proposal_item_ids?: string[] | null;
    };
    BundleSourceFields: {
      branch?: string | null;
      commit_sha?: string | null;
    };
    CatalogItemProposalFields: {
      proposal_risk?: components["schemas"]["ProposalRisk"] | null;
    };
    CoverageCellProposalFields: {
      proposal_item_ids?: string[];
    };
    ExplanationStructuredCreateFields: {
      structured?: components["schemas"]["ExplanationStructured"] | null;
    };
    ExplanationStructuredFields: {
      structured?: components["schemas"]["ExplanationStructured"] | null;
    };
    RunConfigSnapshotStage11Fields: {
      bundle_commit?: string | null;
      scenario_ids?: string[] | null;
    };
    RunCreateSubsetFields: {
      scenario_ids?: string[] | null;
      target_id?: string | null;
    };
    RunTriggerAgent: "agent";
    AgentSession: {
      /**
       * Active
       * @description true while the session has not ended and started less than twelve hours ago
       */
      active: boolean;
      /** Claude Session Id */
      claude_session_id: string;
      /** Cwd Label */
      cwd_label: string;
      /** Ended At */
      ended_at: string | null;
      /**
       * Id
       * Format: uuid
       */
      id: string;
      /** Plugin Version */
      plugin_version: string;
      /**
       * Started At
       * Format: date-time
       */
      started_at: string;
      /** Summary */
      summary: string | null;
      /** Target Id */
      target_id: string | null;
      /**
       * User Id
       * Format: uuid
       */
      user_id: string;
      /** User Name */
      user_name: string;
      /**
       * Write Count
       * @description writes made with a personal token while the session was open
       */
      write_count: number;
    };
    AgentSessionChangedEvent: {
      payload: components["schemas"]["AgentSessionChangedPayload"];
      /**
       * Run Id
       * @description run the event belongs to; null for feed-only events
       */
      run_id: string | null;
      /**
       * Seq
       * @description per-run sequence from 1; null for ephemeral events
       */
      seq: number | null;
      /**
       * Ts
       * Format: date-time
       * @description event time reported by the producer
       */
      ts: string;
      /**
       * @description discriminator enum property added by openapi-typescript
       * @enum {string}
       */
      type: "agent_session.changed";
    };
    AgentSessionChangedPayload: {
      /**
       * Active
       * @description false once the session ended
       */
      active: boolean;
      /**
       * Agent Session Id
       * Format: uuid
       * @description Claude Code session that started, moved or ended
       */
      agent_session_id: string;
      /**
       * Target Id
       * @description target the session works on, when it has one
       */
      target_id: string | null;
      /**
       * User Id
       * Format: uuid
       * @description user the session belongs to
       */
      user_id: string;
    };
    AgentSessionCreate: {
      /**
       * Claude Session Id
       * @description id of the Claude Code session; a second create with the id of a session that is still open returns that session
       */
      claude_session_id: string;
      /**
       * Cwd Label
       * @description name of the working folder, never a full path
       */
      cwd_label: string;
      /** Plugin Version */
      plugin_version: string;
      /**
       * Target Id
       * @description target the session works on, when it already knows
       */
      target_id?: string | null;
    };
    AgentSessionPage: {
      /** Items */
      items: components["schemas"]["AgentSession"][];
      /** Next Cursor */
      next_cursor: string | null;
      /** Total */
      total: number | null;
    };
    AgentSessionUpdate: {
      /**
       * Ended At
       * @description when the session ended, with a UTC offset; Tessa clamps it between the start of the session and now, so a skewed clock never loses the end, and the first value sticks
       */
      ended_at?: string | null;
      /**
       * Summary
       * @description what the session did, written by the plugin when the session stops
       */
      summary?: string | null;
      /**
       * Target Id
       * @description new target of the session; an explicit null clears it
       */
      target_id?: string | null;
    };
    AuditAction:
      | "user_created"
      | "user_role_changed"
      | "user_active_changed"
      | "sso_user_provisioned"
      | "team_created"
      | "team_renamed"
      | "team_members_changed"
      | "team_budget_set"
      | "target_team_changed"
      | "retention_policy_changed"
      | "secret_set"
      | "secret_deleted"
      | "allow_production_changed"
      | "allow_jev_changed"
      | "token_created"
      | "token_revoked"
      | "personal_token_write"
      | "proposal_put"
      | "proposal_item_changed";
    AuditEvent: {
      action: components["schemas"]["AuditAction"];
      /**
       * Actor User Id
       * @description user who made the change; null for system changes such as SSO provisioning
       */
      actor_user_id: string | null;
      /**
       * Agent Session Id
       * @description Claude Code session that made the change; set for personal tokens that sent X-Agent-Session
       */
      agent_session_id: string | null;
      /**
       * Created At
       * Format: date-time
       */
      created_at: string;
      /**
       * Detail
       * @description what changed, before and after; never a secret value or a password
       */
      detail: {
        [key: string]: Known["schemas"]["JsonValue"];
      };
      /**
       * Id
       * Format: uuid
       */
      id: string;
      /**
       * Subject Id
       * @description id of the changed user, team, target, token or proposal item, or of the resource a personal token wrote; null for secrets and retention
       */
      subject_id: string | null;
      subject_type: components["schemas"]["AuditSubjectType"];
      /** @description how the change reached the API: web for a browser session, mcp for a personal token, svc for the service key */
      via: components["schemas"]["AuditVia"];
    };
    AuditEventPage: {
      /** Items */
      items: components["schemas"]["AuditEvent"][];
      /** Next Cursor */
      next_cursor: string | null;
      /** Total */
      total: number | null;
    };
    AuditSubjectType:
      "user" | "team" | "target" | "secret" | "retention" | "personal_token" | "route" | "proposal";
    AuditVia: "web" | "mcp" | "svc";
    BundleValidationReport: {
      /** Branch */
      branch: string | null;
      /** Commit Sha */
      commit_sha: string | null;
      completeness: Known["schemas"]["BundleCompleteness"];
      /** @description against the latest valid version of the target; null without a target */
      diff_summary: Known["schemas"]["BundleDiffSummary"] | null;
      /** Errors */
      errors: Known["schemas"]["BundleValidationError"][];
      /** Feature Count */
      feature_count: number;
      /** File Count */
      file_count: number;
      /**
       * Fixup Items
       * @description everything that is open, errors first, in the order the Fix-up prompt would list it
       */
      fixup_items: components["schemas"]["FixupItem"][];
      /** Hooks Missing */
      hooks_missing: Known["schemas"]["BundleHookMissing"][];
      /** @description check of tessa/proposal.yaml; null when the bundle has none */
      proposal: components["schemas"]["ProposalCheck"] | null;
      /** Size Bytes */
      size_bytes: number;
      validation_status: Known["schemas"]["BundleValidationStatus"];
      /** Warnings */
      warnings: Known["schemas"]["BundleValidationError"][];
    };
    ExplanationFile: {
      /**
       * Lines
       * @description line or range of lines, such as 12 or 12-40
       */
      lines?: string | null;
      /**
       * Path
       * @description path from the repository root with forward slashes, never absolute
       */
      path: string;
    };
    ExplanationOpinion: "app_bug" | "scenario_bug" | "harness" | "unknown";
    ExplanationStructured: {
      /**
       * Commit
       * @description commit that introduced the defect, when known, as 7 to 40 hex digits
       */
      commit?: string | null;
      /** @description how sure the explanation is */
      confidence: Known["schemas"]["Confidence"];
      /**
       * Files
       * @description files and lines the cause lives in
       */
      files?: components["schemas"]["ExplanationFile"][];
      /**
       * Fix Branch
       * @description branch that holds a fix, when one was made
       */
      fix_branch?: string | null;
      /** @description what the evidence says is wrong: the app, the scenario, the harness, or unknown when the code does not settle it */
      opinion: components["schemas"]["ExplanationOpinion"];
      /**
       * Root Cause
       * @description the cause in a few sentences
       */
      root_cause: string;
    };
    FixupItem: {
      /** Fix Hint */
      fix_hint?: string | null;
      /**
       * Kind
       * @description error and warning come from validation, check from a completeness point
       * @enum {string}
       */
      kind: "error" | "check" | "warning";
      /**
       * Location
       * @description file, pointer and line, or the completeness check
       */
      location: string;
      /** Message */
      message: string;
    };
    PersonalToken: {
      /**
       * Created At
       * Format: date-time
       */
      created_at: string;
      /**
       * Expires At
       * Format: date-time
       */
      expires_at: string;
      /**
       * Id
       * Format: uuid
       */
      id: string;
      /**
       * Last Used At
       * @description last request made with the token, written at most once a minute
       */
      last_used_at: string | null;
      /** Name */
      name: string;
      /**
       * Prefix
       * @description first characters of the token, enough to recognise it and never enough to use it
       */
      prefix: string;
      /** Revoked At */
      revoked_at: string | null;
      /**
       * State
       * @description state at the time of the response
       * @enum {string}
       */
      state: "active" | "expired" | "revoked";
      /**
       * User Id
       * Format: uuid
       */
      user_id: string;
    };
    PersonalTokenCreate: {
      /**
       * Expires In Days
       * @description lifetime in days; absent uses TESSA_PERSONAL_TOKEN_MAX_DAYS, which is also the ceiling: a larger value is 422 validation_failed
       */
      expires_in_days?: number | null;
      /**
       * Name
       * @description what the token is for, for example the laptop it lives on
       */
      name: string;
    };
    PersonalTokenCreated: {
      item: components["schemas"]["PersonalToken"];
      /**
       * Token
       * @description the full token, ipt_ followed by 43 characters; shown once and never returned again
       */
      token: string;
    };
    PersonalTokenList: {
      /** Items */
      items: components["schemas"]["PersonalToken"][];
    };
    Proposal: {
      /** Branch */
      branch: string | null;
      /** Bundle Id */
      bundle_id: string | null;
      /** Commit Sha */
      commit_sha: string | null;
      /**
       * Created At
       * Format: date-time
       */
      created_at: string;
      /**
       * Created By
       * Format: uuid
       */
      created_by: string;
      /**
       * Generated At
       * Format: date-time
       */
      generated_at: string;
      /**
       * Id
       * Format: uuid
       */
      id: string;
      /** Items */
      items: components["schemas"]["ProposalItem"][];
      source: components["schemas"]["ProposalOrigin"];
      /**
       * Stale
       * @description true when the target has a newer valid bundle than the one the proposal was written against
       */
      stale: boolean;
      /**
       * Target Id
       * Format: uuid
       */
      target_id: string;
    };
    ProposalCheck: {
      /**
       * Errors
       * @description problems that keep the proposal from being imported; they never make the bundle itself invalid
       */
      errors: Known["schemas"]["BundleValidationError"][];
      /**
       * Items
       * @description items of tessa/proposal.yaml that parsed
       */
      items: number;
      /** Warnings */
      warnings: Known["schemas"]["BundleValidationError"][];
    };
    ProposalEstimate: {
      /**
       * Minutes
       * @description minutes one run of those scenarios takes
       */
      minutes: number;
      /**
       * Scenarios
       * @description scenarios the item would add
       */
      scenarios: number;
    };
    ProposalItem: {
      /** Area */
      area: string;
      /**
       * Cell Ids
       * @description cells of the coverage baseline plan of the latest valid bundle that the item maps to, computed when the proposal is read
       */
      cell_ids: string[];
      confidence: Known["schemas"]["Confidence"];
      depth: Known["schemas"]["Depth"];
      estimate: components["schemas"]["ProposalEstimate"] | null;
      /** Evidence */
      evidence: string | null;
      /** Feature Ids */
      feature_ids: string[];
      /**
       * Id
       * Format: uuid
       */
      id: string;
      /** Interface Id */
      interface_id: string | null;
      /** Key */
      key: string;
      kind: components["schemas"]["ProposalKind"];
      /** Needs */
      needs: components["schemas"]["ProposalNeed"][];
      /**
       * Note
       * @description the note a person left when they ticked or declined
       */
      note: string | null;
      /** Reasons */
      reasons: components["schemas"]["ProposalItemReason"][];
      risk: components["schemas"]["ProposalRisk"];
      /**
       * Scenario Ids
       * @description scenarios authored for the item
       */
      scenario_ids: string[];
      /** Selected At */
      selected_at: string | null;
      /** Selected By */
      selected_by: string | null;
      /** @description proposed, selected or declined by people; authored once a scenario file answered an Author prompt for the item; covered when every cell it maps to is covered */
      status: components["schemas"]["ProposalItemStatus"];
      /** Title */
      title: string;
    };
    ProposalItemChoice: "proposed" | "selected" | "declined";
    ProposalItemReason: {
      /** @description why the area is worth testing */
      code: components["schemas"]["ProposalReason"];
      /**
       * Note
       * @description what in the repository shows it, for example a file, a commit or a count
       */
      note?: string | null;
    };
    ProposalItemStatus: "proposed" | "selected" | "declined" | "authored" | "covered";
    ProposalItemUpdate: {
      /**
       * Note
       * @description why the item was ticked or declined; absent keeps the current note
       */
      note?: string | null;
      /** @description proposed, selected or declined; authored and covered are set by Tessa */
      status: components["schemas"]["ProposalItemChoice"];
    };
    ProposalKind:
      "api" | "browser" | "stream" | "webhook" | "pipeline" | "contract" | "integration";
    ProposalNeed: "seed" | "db_read" | "hook" | "flag" | "fixture" | "credentials";
    ProposalOrigin: "bundle" | "put";
    ProposalPlanCreate: {
      /**
       * Item Ids
       * @description items to plan; absent plans every selected item of the current proposal
       */
      item_ids?: string[] | null;
      /** Name */
      name?: string | null;
    };
    ProposalPut: {
      /**
       * Yaml
       * @description content of tessa/proposal.yaml, validated like the file of a bundle
       */
      yaml: string;
    };
    ProposalReason:
      | "recent_change"
      | "no_unit_tests"
      | "auth_path"
      | "money_path"
      | "migration"
      | "complexity"
      | "bug_history"
      | "external_dependency"
      | "user_visible";
    ProposalRisk: "high" | "medium" | "low";
    ProposalUpdatedEvent: {
      payload: components["schemas"]["ProposalUpdatedPayload"];
      /**
       * Run Id
       * @description run the event belongs to; null for feed-only events
       */
      run_id: string | null;
      /**
       * Seq
       * @description per-run sequence from 1; null for ephemeral events
       */
      seq: number | null;
      /**
       * Ts
       * Format: date-time
       * @description event time reported by the producer
       */
      ts: string;
      /**
       * @description discriminator enum property added by openapi-typescript
       * @enum {string}
       */
      type: "proposal.updated";
    };
    ProposalUpdatedPayload: {
      /**
       * Item Id
       * @description item that changed; null when the whole proposal was replaced
       */
      item_id: string | null;
      /**
       * Proposal Id
       * Format: uuid
       * @description proposal that changed
       */
      proposal_id: string;
      /** @description new status of that item; null with it */
      status: components["schemas"]["ProposalItemStatus"] | null;
      /**
       * Target Id
       * Format: uuid
       * @description target whose test proposal changed
       */
      target_id: string;
    };
    ProposePromptParams: {
      /**
       * Focus
       * @description catalog areas to concentrate on; empty looks at every area
       */
      focus?: string[];
      /**
       * Since Commit
       * @description rank by what changed after this commit, as 7 to 40 hex digits; absent looks at the whole history that matters
       */
      since_commit?: string | null;
      /**
       * @description discriminator enum property added by openapi-typescript
       * @enum {string}
       */
      template_name: "propose";
    };
  };
  responses: never;
  parameters: never;
  requestBodies: never;
  headers: never;
  pathItems: never;
}

export type $defs = Record<string, never>;

export interface operations {
  agent_sessions_list_agent_sessions: {
    parameters: {
      query?: {
        /** @description only sessions on this target */
        target_id?: string | null;
        /** @description only sessions of this user */
        user_id?: string | null;
        /** @description true only open sessions, false only ended or stale */
        active?: boolean | null;
        /** @description Page size, at most 200 */
        limit?: number;
        /** @description Opaque next_cursor of a previous page */
        cursor?: string | null;
        /** @description Count all matching rows into total */
        include_total?: boolean;
        /** @description Comma separated sort keys, a leading minus sorts descending. Allowed: started_at. Default: -started_at. */
        sort?: string | null;
      };
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["AgentSessionPage"];
        };
      };
      /** @description Missing, invalid or expired credentials */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": Known["schemas"]["ErrorResponse"];
        };
      };
      /** @description Authenticated but not allowed */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": Known["schemas"]["ErrorResponse"];
        };
      };
      /** @description Request validation failed */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": Known["schemas"]["ErrorResponse"];
        };
      };
    };
  };
  agent_sessions_create_agent_session: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["AgentSessionCreate"];
      };
    };
    responses: {
      /** @description The session was already open */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["AgentSession"];
        };
      };
      /** @description Successful Response */
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["AgentSession"];
        };
      };
      /** @description Missing, invalid or expired credentials */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": Known["schemas"]["ErrorResponse"];
        };
      };
      /** @description Authenticated but not allowed */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": Known["schemas"]["ErrorResponse"];
        };
      };
      /** @description Resource not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": Known["schemas"]["ErrorResponse"];
        };
      };
      /** @description Request validation failed */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": Known["schemas"]["ErrorResponse"];
        };
      };
    };
  };
  agent_sessions_update_agent_session: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        agent_session_id: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["AgentSessionUpdate"];
      };
    };
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["AgentSession"];
        };
      };
      /** @description Missing, invalid or expired credentials */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": Known["schemas"]["ErrorResponse"];
        };
      };
      /** @description Authenticated but not allowed */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": Known["schemas"]["ErrorResponse"];
        };
      };
      /** @description Resource not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": Known["schemas"]["ErrorResponse"];
        };
      };
      /** @description Request validation failed */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": Known["schemas"]["ErrorResponse"];
        };
      };
    };
  };
  audit_list_audit_events: {
    parameters: {
      query?: {
        /** @description only changes made by this user */
        actor_user_id?: string | null;
        /** @description how the change reached the API */
        via?: components["schemas"]["AuditVia"] | null;
        /** @description only changes to this kind of subject */
        subject_type?: components["schemas"]["AuditSubjectType"] | null;
        /** @description only changes to this subject */
        subject_id?: string | null;
        /** @description only changes made during this agent session */
        agent_session_id?: string | null;
        /** @description only changes at or after this moment, with an offset */
        since?: string | null;
        /** @description Page size, at most 200 */
        limit?: number;
        /** @description Opaque next_cursor of a previous page */
        cursor?: string | null;
        /** @description Count all matching rows into total */
        include_total?: boolean;
        /** @description Comma separated sort keys, a leading minus sorts descending. Allowed: created_at. Default: -created_at. */
        sort?: string | null;
      };
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["AuditEventPage"];
        };
      };
      /** @description Missing, invalid or expired credentials */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": Known["schemas"]["ErrorResponse"];
        };
      };
      /** @description Authenticated but not allowed */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": Known["schemas"]["ErrorResponse"];
        };
      };
      /** @description Request validation failed */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": Known["schemas"]["ErrorResponse"];
        };
      };
    };
  };
  bundles_validate_bundle_upload: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        "multipart/form-data": Known["schemas"]["BundleUploadForm"];
      };
    };
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["BundleValidationReport"];
        };
      };
      /** @description Bad request */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": Known["schemas"]["ErrorResponse"];
        };
      };
      /** @description Missing, invalid or expired credentials */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": Known["schemas"]["ErrorResponse"];
        };
      };
      /** @description Authenticated but not allowed */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": Known["schemas"]["ErrorResponse"];
        };
      };
      /** @description Conflict with the current state */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": Known["schemas"]["ErrorResponse"];
        };
      };
      /** @description Payload too large */
      413: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": Known["schemas"]["ErrorResponse"];
        };
      };
      /** @description Unsupported media type */
      415: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": Known["schemas"]["ErrorResponse"];
        };
      };
      /** @description Request validation failed */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": Known["schemas"]["ErrorResponse"];
        };
      };
    };
  };
  proposals_update_proposal_item: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        item_id: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["ProposalItemUpdate"];
      };
    };
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ProposalItem"];
        };
      };
      /** @description Missing, invalid or expired credentials */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": Known["schemas"]["ErrorResponse"];
        };
      };
      /** @description Authenticated but not allowed */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": Known["schemas"]["ErrorResponse"];
        };
      };
      /** @description Resource not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": Known["schemas"]["ErrorResponse"];
        };
      };
      /** @description Conflict with the current state */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": Known["schemas"]["ErrorResponse"];
        };
      };
      /** @description Request validation failed */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": Known["schemas"]["ErrorResponse"];
        };
      };
    };
  };
  proposals_read_proposal: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        target_id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["Proposal"];
        };
      };
      /** @description Missing, invalid or expired credentials */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": Known["schemas"]["ErrorResponse"];
        };
      };
      /** @description Authenticated but not allowed */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": Known["schemas"]["ErrorResponse"];
        };
      };
      /** @description Resource not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": Known["schemas"]["ErrorResponse"];
        };
      };
      /** @description Request validation failed */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": Known["schemas"]["ErrorResponse"];
        };
      };
    };
  };
  proposals_put_proposal: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        target_id: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["ProposalPut"];
      };
    };
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["Proposal"];
        };
      };
      /** @description Missing, invalid or expired credentials */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": Known["schemas"]["ErrorResponse"];
        };
      };
      /** @description Authenticated but not allowed */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": Known["schemas"]["ErrorResponse"];
        };
      };
      /** @description Resource not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": Known["schemas"]["ErrorResponse"];
        };
      };
      /** @description Conflict with the current state */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": Known["schemas"]["ErrorResponse"];
        };
      };
      /** @description Payload too large */
      413: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": Known["schemas"]["ErrorResponse"];
        };
      };
      /** @description Request validation failed */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": Known["schemas"]["ErrorResponse"];
        };
      };
    };
  };
  proposals_plan_from_proposal: {
    parameters: {
      query?: never;
      header?: {
        /** @description Opaque client-generated key, 8 to 128 printable characters; optional */
        "Idempotency-Key"?: string | null;
      };
      path: {
        target_id: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["ProposalPlanCreate"];
      };
    };
    responses: {
      /** @description Successful Response */
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": Known["schemas"]["Plan"];
        };
      };
      /** @description Bad request */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": Known["schemas"]["ErrorResponse"];
        };
      };
      /** @description Missing, invalid or expired credentials */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": Known["schemas"]["ErrorResponse"];
        };
      };
      /** @description Authenticated but not allowed */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": Known["schemas"]["ErrorResponse"];
        };
      };
      /** @description Resource not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": Known["schemas"]["ErrorResponse"];
        };
      };
      /** @description Conflict with the current state */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": Known["schemas"]["ErrorResponse"];
        };
      };
      /** @description Request validation failed */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": Known["schemas"]["ErrorResponse"];
        };
      };
    };
  };
  personal_tokens_list_my_tokens: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["PersonalTokenList"];
        };
      };
      /** @description Missing, invalid or expired credentials */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": Known["schemas"]["ErrorResponse"];
        };
      };
      /** @description Authenticated but not allowed */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": Known["schemas"]["ErrorResponse"];
        };
      };
    };
  };
  personal_tokens_create_my_token: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["PersonalTokenCreate"];
      };
    };
    responses: {
      /** @description Successful Response */
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["PersonalTokenCreated"];
        };
      };
      /** @description Missing, invalid or expired credentials */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": Known["schemas"]["ErrorResponse"];
        };
      };
      /** @description Authenticated but not allowed */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": Known["schemas"]["ErrorResponse"];
        };
      };
      /** @description Conflict with the current state */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": Known["schemas"]["ErrorResponse"];
        };
      };
      /** @description Request validation failed */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": Known["schemas"]["ErrorResponse"];
        };
      };
    };
  };
  personal_tokens_revoke_my_token: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        token_id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      204: {
        headers: {
          [name: string]: unknown;
        };
        content?: never;
      };
      /** @description Missing, invalid or expired credentials */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": Known["schemas"]["ErrorResponse"];
        };
      };
      /** @description Authenticated but not allowed */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": Known["schemas"]["ErrorResponse"];
        };
      };
      /** @description Resource not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": Known["schemas"]["ErrorResponse"];
        };
      };
      /** @description Request validation failed */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": Known["schemas"]["ErrorResponse"];
        };
      };
    };
  };
  personal_tokens_list_user_tokens: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        user_id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["PersonalTokenList"];
        };
      };
      /** @description Missing, invalid or expired credentials */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": Known["schemas"]["ErrorResponse"];
        };
      };
      /** @description Authenticated but not allowed */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": Known["schemas"]["ErrorResponse"];
        };
      };
      /** @description Resource not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": Known["schemas"]["ErrorResponse"];
        };
      };
      /** @description Request validation failed */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": Known["schemas"]["ErrorResponse"];
        };
      };
    };
  };
  personal_tokens_revoke_user_token: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        user_id: string;
        token_id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      204: {
        headers: {
          [name: string]: unknown;
        };
        content?: never;
      };
      /** @description Missing, invalid or expired credentials */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": Known["schemas"]["ErrorResponse"];
        };
      };
      /** @description Authenticated but not allowed */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": Known["schemas"]["ErrorResponse"];
        };
      };
      /** @description Resource not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": Known["schemas"]["ErrorResponse"];
        };
      };
      /** @description Request validation failed */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": Known["schemas"]["ErrorResponse"];
        };
      };
    };
  };
}
