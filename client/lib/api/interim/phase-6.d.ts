import type { components as Known } from "../schema";

export interface paths {
    "/api/v1/coverage": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["coverage_read_coverage"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/coverage/generate": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["coverage_generate_coverage"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/feeds/coverage": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["feeds_stream_coverage_feed"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/scenarios": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["scenarios_create_scenario"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/scenarios/validate": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["scenarios_validate_scenario"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/scenarios/{scenario_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put: operations["scenarios_update_scenario"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch: operations["scenarios_patch_scenario"];
        trace?: never;
    };
    "/api/v1/scenarios/{scenario_id}/provenance": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["scenarios_read_provenance"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/scenarios/{scenario_id}/review": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["scenarios_review_scenario"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/scenarios/{scenario_id}/versions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["scenarios_list_versions"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
}

export type webhooks = Record<string, never>;

export interface components {
    schemas: {
        AuthorPromptParams: {
            cell_ids: string[];
            template_name: "author";
        };
        CoverageColumn: {
            interface_id: string;
            role: string;
        };
        CoverageGenerateCreate: {
            budget?: Known["schemas"]["Budget"] | null;
            cell_ids: string[];
            depth: Known["schemas"]["Depth"];
            plan_id: string;
        };
        CoverageMap: {
            bundle_id: string;
            cells: Known["schemas"]["CoverageCell"][];
            columns: components["schemas"]["CoverageColumn"][];
            plan_id: string;
            rows: components["schemas"]["CoverageRow"][];
            target_id: string;
            totals: components["schemas"]["CoverageTotals"];
        };
        CoverageRow: {
            area: string;
            feature_id: string;
            title: string;
        };
        CoverageTotals: {
            blocked: number;
            covered: number;
            empty: number;
            generated: number;
            needs_author: number;
        };
        CoverageUpdateReason: "generated" | "run" | "review";
        CoverageUpdatedEvent: {
            payload: components["schemas"]["CoverageUpdatedPayload"];
            run_id: string | null;
            seq: number | null;
            ts: string;
            type: "coverage.updated";
        };
        CoverageUpdatedPayload: {
            cell_ids: string[];
            plan_id: string | null;
            reason: components["schemas"]["CoverageUpdateReason"];
            target_id: string;
        };
        GenerationProgressEvent: {
            payload: components["schemas"]["GenerationProgressPayload"];
            run_id: string | null;
            seq: number | null;
            ts: string;
            type: "generation.progress";
        };
        GenerationProgressPayload: {
            cells_done: number;
            cells_total: number;
            scenarios_created: number;
            scenarios_invalid: number;
        };
        PlanApiFuzz: {
            include_api_fuzz: boolean;
        };
        PlanCreateApiFuzz: {
            include_api_fuzz?: boolean;
        };
        ReviewDecision: "accept" | "reject";
        ScenarioChangedEvent: {
            payload: components["schemas"]["ScenarioChangedPayload"];
            run_id: string | null;
            seq: number | null;
            ts: string;
            type: "scenario.changed";
        };
        ScenarioChangedPayload: {
            cell_id: string | null;
            scenario_id: string;
            status: Known["schemas"]["ScenarioStatus"];
        };
        ScenarioCreate: {
            target_id: string;
            yaml: string;
        };
        ScenarioDryRun: {
            run_id: string;
            run_scenario_id: string;
            verdict: Known["schemas"]["Verdict"];
        };
        ScenarioGenerator: {
            effort: Known["schemas"]["Effort"];
            model: string;
            template_version: number;
        };
        ScenarioPatch: {
            status: components["schemas"]["ScenarioPatchStatus"];
        };
        ScenarioPatchStatus: "retired" | "quarantined" | "accepted";
        ScenarioProvenance: {
            bundle_id: string;
            bundle_version: number;
            cell_id: string | null;
            created_at: string;
            dry_runs: components["schemas"]["ScenarioDryRun"][];
            finding_id: string | null;
            generator: components["schemas"]["ScenarioGenerator"] | null;
            prompt_issue_id: string | null;
            replay_id: string | null;
            ticket_url: string | null;
        };
        ScenarioReviewCreate: {
            decision: components["schemas"]["ReviewDecision"];
            note?: string | null;
        };
        ScenarioUpdate: {
            base_version: number;
            yaml: string;
        };
        ScenarioValidateRequest: {
            target_id: string;
            yaml: string;
        };
        ScenarioVersion: {
            created_at: string;
            created_by: string | null;
            note: string | null;
            parsed: {
                [key: string]: unknown;
            };
            scenario_id: string;
            version: number;
            yaml: string;
        };
        ScenarioVersionPage: {
            items: components["schemas"]["ScenarioVersion"][];
            next_cursor: string | null;
            total: number | null;
        };
        Stage6StreamEvent: components["schemas"]["ScenarioChangedEvent"] | components["schemas"]["CoverageUpdatedEvent"] | components["schemas"]["GenerationProgressEvent"];
    };
    responses: never;
    parameters: never;
    requestBodies: never;
    headers: never;
    pathItems: never;
}

export type $defs = Record<string, never>;

export interface operations {
    coverage_read_coverage: {
        parameters: {
            query: {
                target_id: string;
                plan_id?: string | null;
                bundle_id?: string | null;
                area?: string[] | null;
                status?: Known["schemas"]["CellStatus"][] | null;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CoverageMap"];
                };
            };
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": Known["schemas"]["ErrorResponse"];
                };
            };
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": Known["schemas"]["ErrorResponse"];
                };
            };
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": Known["schemas"]["ErrorResponse"];
                };
            };
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
    coverage_generate_coverage: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": string;
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CoverageGenerateCreate"];
            };
        };
        responses: {
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": Known["schemas"]["RunHandle"];
                };
            };
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": Known["schemas"]["ErrorResponse"];
                };
            };
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": Known["schemas"]["ErrorResponse"];
                };
            };
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": Known["schemas"]["ErrorResponse"];
                };
            };
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": Known["schemas"]["ErrorResponse"];
                };
            };
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": Known["schemas"]["ErrorResponse"];
                };
            };
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": Known["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    feeds_stream_coverage_feed: {
        parameters: {
            query?: {
                target_id?: string | null;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "text/event-stream": string;
                };
            };
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": Known["schemas"]["ErrorResponse"];
                };
            };
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": Known["schemas"]["ErrorResponse"];
                };
            };
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
    scenarios_create_scenario: {
        parameters: {
            query?: never;
            header?: {
                "Idempotency-Key"?: string | null;
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ScenarioCreate"];
            };
        };
        responses: {
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": Known["schemas"]["Scenario"];
                };
            };
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": Known["schemas"]["ErrorResponse"];
                };
            };
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": Known["schemas"]["ErrorResponse"];
                };
            };
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": Known["schemas"]["ErrorResponse"];
                };
            };
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": Known["schemas"]["ErrorResponse"];
                };
            };
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": Known["schemas"]["ErrorResponse"];
                };
            };
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
    scenarios_validate_scenario: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ScenarioValidateRequest"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": Known["schemas"]["ScenarioValidation"];
                };
            };
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": Known["schemas"]["ErrorResponse"];
                };
            };
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": Known["schemas"]["ErrorResponse"];
                };
            };
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": Known["schemas"]["ErrorResponse"];
                };
            };
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
    scenarios_update_scenario: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                scenario_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ScenarioUpdate"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": Known["schemas"]["Scenario"];
                };
            };
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": Known["schemas"]["ErrorResponse"];
                };
            };
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": Known["schemas"]["ErrorResponse"];
                };
            };
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": Known["schemas"]["ErrorResponse"];
                };
            };
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": Known["schemas"]["ErrorResponse"];
                };
            };
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
    scenarios_patch_scenario: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                scenario_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ScenarioPatch"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": Known["schemas"]["Scenario"];
                };
            };
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": Known["schemas"]["ErrorResponse"];
                };
            };
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": Known["schemas"]["ErrorResponse"];
                };
            };
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": Known["schemas"]["ErrorResponse"];
                };
            };
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": Known["schemas"]["ErrorResponse"];
                };
            };
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
    scenarios_read_provenance: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                scenario_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ScenarioProvenance"];
                };
            };
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": Known["schemas"]["ErrorResponse"];
                };
            };
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": Known["schemas"]["ErrorResponse"];
                };
            };
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": Known["schemas"]["ErrorResponse"];
                };
            };
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
    scenarios_review_scenario: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                scenario_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ScenarioReviewCreate"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": Known["schemas"]["Scenario"];
                };
            };
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": Known["schemas"]["ErrorResponse"];
                };
            };
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": Known["schemas"]["ErrorResponse"];
                };
            };
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": Known["schemas"]["ErrorResponse"];
                };
            };
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": Known["schemas"]["ErrorResponse"];
                };
            };
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
    scenarios_list_versions: {
        parameters: {
            query?: {
                limit?: number;
                cursor?: string | null;
                include_total?: boolean;
                sort?: string | null;
            };
            header?: never;
            path: {
                scenario_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ScenarioVersionPage"];
                };
            };
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": Known["schemas"]["ErrorResponse"];
                };
            };
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": Known["schemas"]["ErrorResponse"];
                };
            };
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": Known["schemas"]["ErrorResponse"];
                };
            };
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
