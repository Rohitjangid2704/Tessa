import type { components as Known } from "../schema";

export interface paths {
    "/api/v1/feeds/findings": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["feeds_stream_findings_feed"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/findings": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["findings_list_findings"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/findings/{finding_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["findings_read_finding"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch: operations["findings_update_finding"];
        trace?: never;
    };
    "/api/v1/findings/{finding_id}/explanations": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["findings_list_explanations"];
        put?: never;
        post: operations["findings_create_explanation"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/findings/{finding_id}/occurrences": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["findings_list_occurrences"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/findings/{finding_id}/promote": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["findings_promote_finding"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/findings/{finding_id}/repro": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["findings_read_repro"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/invariants": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["invariants_list_invariants"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/runs/{run_id}/diff": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["runs_read_run_diff"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/runs/{run_id}/invariants": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["runs_list_run_invariants"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/runs/{run_id}/stats": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["runs_read_run_stats"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/trends": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["trends_read_trend"];
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
        CostPercentiles: {
            p50: number;
            p90: number;
            total: number;
        };
        ExplainPromptParams: {
            finding_id: string;
            template_name: "explain";
        };
        Explanation: {
            created_at: string;
            created_by: string;
            finding_id: string;
            id: string;
            source: components["schemas"]["ExplanationSource"];
            text: string;
        };
        ExplanationCreate: {
            text: string;
        };
        ExplanationPage: {
            items: components["schemas"]["Explanation"][];
            next_cursor: string | null;
            total: number | null;
        };
        ExplanationSource: "claude_code";
        FamilyStats: {
            family: string;
            flaky: number;
            pass_hat_k: number;
            scenarios: number;
            skipped: number;
            uncertain: number;
        };
        Finding: {
            actual: Known["schemas"]["JsonValue"];
            class: components["schemas"]["FindingClass"];
            expected: Known["schemas"]["JsonValue"];
            fingerprint: string;
            first_seen_at: string;
            first_seen_run_id: string;
            id: string;
            invariant_id: string | null;
            known_gap_reason: string | null;
            last_seen_at: string;
            last_seen_run_id: string;
            latest_explanation: components["schemas"]["Explanation"] | null;
            occurrence_count: number;
            promoted_scenario_id: string | null;
            scenario_id: string | null;
            severity: components["schemas"]["Severity"];
            status: components["schemas"]["FindingStatus"];
            target_id: string;
            ticket_url: string | null;
            title: string;
        };
        FindingChange: {
            from: Known["schemas"]["JsonValue"];
            to: Known["schemas"]["JsonValue"];
        };
        FindingClass: "wrong_result" | "invariant_violation" | "server_error" | "security_boundary" | "safety_claim" | "performance" | "accessibility" | "flaky" | "contract" | "harness";
        FindingCreatedEvent: {
            payload: components["schemas"]["FindingCreatedPayload"];
            run_id: string | null;
            seq: number | null;
            ts: string;
            type: "finding.created";
        };
        FindingCreatedPayload: {
            class: components["schemas"]["FindingClass"];
            finding_id: string;
            fingerprint: string;
            is_new: boolean;
            scenario_id: string | null;
            severity: components["schemas"]["Severity"];
            status: components["schemas"]["FindingStatus"];
            title: string;
        };
        FindingOccurrence: {
            attempt: number | null;
            evidence: {
                [key: string]: unknown;
            };
            finding_id: string;
            id: string;
            run_id: string;
            run_scenario_id: string | null;
            seen_at: string;
            step_id: string | null;
        };
        FindingOccurrenceAddedEvent: {
            payload: components["schemas"]["FindingOccurrenceAddedPayload"];
            run_id: string | null;
            seq: number | null;
            ts: string;
            type: "finding.occurrence_added";
        };
        FindingOccurrenceAddedPayload: {
            finding_id: string;
            occurrence_count: number;
            run_id: string;
        };
        FindingOccurrencePage: {
            items: components["schemas"]["FindingOccurrence"][];
            next_cursor: string | null;
            total: number | null;
        };
        FindingPage: {
            items: components["schemas"]["FindingSummary"][];
            next_cursor: string | null;
            total: number | null;
        };
        FindingRepro: {
            actual: Known["schemas"]["JsonValue"];
            attempt: number;
            browser_session_id: string | null;
            bundle_version: number;
            clock: Known["schemas"]["ClockSnapshot"];
            expected: Known["schemas"]["JsonValue"];
            finding_id: string;
            invariant_id: string | null;
            oracle_rows: {
                [key: string]: unknown;
            }[];
            run_id: string;
            run_scenario_id: string;
            scenario_id: string;
            scenario_version: number;
            scenario_yaml: string;
            screencast: Known["schemas"]["ArtifactRef"][];
            seed: components["schemas"]["ReproSeed"];
            transcript: components["schemas"]["ReproTranscriptRow"][];
        };
        FindingStatus: "new" | "triaged" | "in_fix" | "verifying" | "resolved" | "known_gap" | "dismissed";
        FindingSummary: {
            class: components["schemas"]["FindingClass"];
            fingerprint: string;
            first_seen_at: string;
            id: string;
            invariant_id: string | null;
            known_gap_reason: string | null;
            last_seen_at: string;
            occurrence_count: number;
            promoted_scenario_id: string | null;
            scenario_id: string | null;
            severity: components["schemas"]["Severity"];
            status: components["schemas"]["FindingStatus"];
            target_id: string;
            ticket_url: string | null;
            title: string;
        };
        FindingUpdate: {
            known_gap_reason?: string | null;
            severity?: components["schemas"]["Severity"] | null;
            status?: components["schemas"]["FindingStatus"] | null;
            ticket_url?: string | null;
        };
        FindingUpdatedEvent: {
            payload: components["schemas"]["FindingUpdatedPayload"];
            run_id: string | null;
            seq: number | null;
            ts: string;
            type: "finding.updated";
        };
        FindingUpdatedPayload: {
            changes: {
                [key: string]: components["schemas"]["FindingChange"];
            };
            finding_id: string;
        };
        InvariantCatalog: {
            items: components["schemas"]["InvariantInfo"][];
        };
        InvariantCheck: "code" | "probe" | "oracle" | "db";
        InvariantInfo: {
            check: components["schemas"]["InvariantCheck"];
            description: string;
            id: string;
            pack: Known["schemas"]["InvariantPack"];
            title: string;
        };
        InvariantResult: {
            attempt: number | null;
            confidence: number | null;
            created_at: string;
            id: string;
            invariant_id: string;
            message: string;
            pack: Known["schemas"]["InvariantPack"];
            run_id: string;
            run_scenario_id: string | null;
            skip_reason: Known["schemas"]["SkipReason"] | null;
            status: Known["schemas"]["VerdictStatus"];
            step_id: string | null;
            tier: Known["schemas"]["VerdictTier"];
        };
        InvariantResultEvent: {
            payload: components["schemas"]["InvariantResultPayload"];
            run_id: string | null;
            seq: number | null;
            ts: string;
            type: "invariant.result";
        };
        InvariantResultPage: {
            items: components["schemas"]["InvariantResult"][];
            next_cursor: string | null;
            total: number | null;
        };
        InvariantResultPayload: {
            attempt: number | null;
            invariant_id: string;
            message: string;
            pack: Known["schemas"]["InvariantPack"];
            run_scenario_id: string | null;
            skip_reason: Known["schemas"]["SkipReason"] | null;
            status: Known["schemas"]["VerdictStatus"];
            tier: Known["schemas"]["VerdictTier"];
        };
        InvariantStats: {
            fail: number;
            flaky: number;
            invariant_id: string;
            pack: Known["schemas"]["InvariantPack"];
            pass: number;
            skipped: number;
            uncertain: number;
        };
        LatencyPercentiles: {
            p50: number;
            p90: number;
            p99: number;
        };
        PromoteFindingCreate: {
            title?: string | null;
        };
        ReproSeed: {
            hash: string | null;
            version: number | null;
        };
        ReproTranscriptRow: {
            answer: string | null;
            ask: string | null;
            index: number;
            label: string;
            step_id: string;
        };
        RunDiff: {
            cost_delta_usd: number;
            fixed: string[];
            flaky_changes: string[];
            items: components["schemas"]["RunDiffItem"][];
            latency_p50_delta_ms: number;
            new_failures: string[];
            still_failing: string[];
        };
        RunDiffCategory: "new_failure" | "fixed" | "still_failing" | "flaky_change" | "unchanged" | "added" | "removed" | "not_comparable";
        RunDiffItem: {
            after: Known["schemas"]["Verdict"] | null;
            against_run_scenario_id: string | null;
            before: Known["schemas"]["Verdict"] | null;
            category: components["schemas"]["RunDiffCategory"];
            comparable: boolean;
            family: string;
            interface_id: string;
            role: string;
            run_scenario_id: string | null;
            scenario_id: string;
            title: string;
        };
        RunStats: {
            cost_usd: components["schemas"]["CostPercentiles"];
            families: components["schemas"]["FamilyStats"][];
            flaky_rate: number | null;
            invariants: components["schemas"]["InvariantStats"][];
            k: number;
            latency_ms: components["schemas"]["LatencyPercentiles"];
            open_findings: number;
            pass_hat_k: number | null;
            tiers: components["schemas"]["TierMix"];
        };
        Severity: "critical" | "high" | "medium" | "low" | "info";
        Stage5StreamEvent: components["schemas"]["InvariantResultEvent"] | components["schemas"]["FindingCreatedEvent"] | components["schemas"]["FindingUpdatedEvent"] | components["schemas"]["FindingOccurrenceAddedEvent"];
        TierMix: {
            code: number;
            human: number;
            judge: number;
            laya: number;
        };
        TrendMetric: "pass_hat_k" | "open_findings" | "cost_usd" | "latency_p50_ms" | "flaky_rate";
        TrendPoint: {
            run_id: string | null;
            ts: string;
            value: number;
        };
        TrendSeries: {
            metric: components["schemas"]["TrendMetric"];
            points: components["schemas"]["TrendPoint"][];
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
    feeds_stream_findings_feed: {
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
    findings_list_findings: {
        parameters: {
            query?: {
                target_id?: string | null;
                status?: components["schemas"]["FindingStatus"][] | null;
                severity?: components["schemas"]["Severity"][] | null;
                class?: components["schemas"]["FindingClass"][] | null;
                invariant_id?: string[] | null;
                run_id?: string | null;
                scenario_id?: string | null;
                fingerprint?: string | null;
                q?: string | null;
                limit?: number;
                cursor?: string | null;
                include_total?: boolean;
                sort?: string | null;
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
                    "application/json": components["schemas"]["FindingPage"];
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
    findings_read_finding: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                finding_id: string;
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
                    "application/json": components["schemas"]["Finding"];
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
    findings_update_finding: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                finding_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["FindingUpdate"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Finding"];
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
    findings_list_explanations: {
        parameters: {
            query?: {
                limit?: number;
                cursor?: string | null;
                include_total?: boolean;
                sort?: string | null;
            };
            header?: never;
            path: {
                finding_id: string;
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
                    "application/json": components["schemas"]["ExplanationPage"];
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
    findings_create_explanation: {
        parameters: {
            query?: never;
            header?: {
                "Idempotency-Key"?: string | null;
            };
            path: {
                finding_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ExplanationCreate"];
            };
        };
        responses: {
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Explanation"];
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
    findings_list_occurrences: {
        parameters: {
            query?: {
                limit?: number;
                cursor?: string | null;
                include_total?: boolean;
                sort?: string | null;
            };
            header?: never;
            path: {
                finding_id: string;
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
                    "application/json": components["schemas"]["FindingOccurrencePage"];
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
    findings_promote_finding: {
        parameters: {
            query?: never;
            header?: {
                "Idempotency-Key"?: string | null;
            };
            path: {
                finding_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PromoteFindingCreate"];
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
    findings_read_repro: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                finding_id: string;
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
                    "application/json": components["schemas"]["FindingRepro"];
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
    invariants_list_invariants: {
        parameters: {
            query?: {
                pack?: Known["schemas"]["InvariantPack"][] | null;
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
                    "application/json": components["schemas"]["InvariantCatalog"];
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
    runs_read_run_diff: {
        parameters: {
            query?: {
                against?: string | null;
            };
            header?: never;
            path: {
                run_id: string;
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
                    "application/json": components["schemas"]["RunDiff"];
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
    runs_list_run_invariants: {
        parameters: {
            query?: {
                status?: Known["schemas"]["VerdictStatus"][] | null;
                invariant_id?: string[] | null;
                pack?: Known["schemas"]["InvariantPack"][] | null;
                limit?: number;
                cursor?: string | null;
                include_total?: boolean;
                sort?: string | null;
            };
            header?: never;
            path: {
                run_id: string;
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
                    "application/json": components["schemas"]["InvariantResultPage"];
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
    runs_read_run_stats: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                run_id: string;
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
                    "application/json": components["schemas"]["RunStats"];
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
    trends_read_trend: {
        parameters: {
            query: {
                target_id: string;
                metric: components["schemas"]["TrendMetric"];
                from?: string | null;
                to?: string | null;
                plan_id?: string | null;
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
                    "application/json": components["schemas"]["TrendSeries"];
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
}
