import type { components as Known } from "../schema";
import type { components as P5 } from "./phase-5";

export interface paths {
    "/api/v1/calibration": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["calibration_read_report"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/dashboard": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["dashboard_read_dashboard"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/feeds/home": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["feeds_stream_home_feed"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/mutants": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["mutants_list_mutants"];
        put?: never;
        post: operations["mutants_create_mutant"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/mutants/{mutant_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete: operations["mutants_delete_mutant"];
        options?: never;
        head?: never;
        patch: operations["mutants_update_mutant"];
        trace?: never;
    };
    "/api/v1/mutation-runs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["mutation_list_mutation_runs"];
        put?: never;
        post: operations["mutation_create_mutation_run"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/mutation-runs/{mutation_run_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["mutation_read_mutation_run"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/mutation/summary": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["mutation_read_summary"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/notifications": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["notifications_list_notifications"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/notifications/read-all": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["notifications_mark_all_read"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/notifications/{notification_id}/read": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["notifications_mark_read"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/runs/{run_id}/report": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["runs_read_run_report"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/runs/{run_id}/report.html": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["runs_read_run_report_html"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/schedules": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["schedules_list_schedules"];
        put?: never;
        post: operations["schedules_create_schedule"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/schedules/{schedule_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["schedules_read_schedule"];
        put?: never;
        post?: never;
        delete: operations["schedules_delete_schedule"];
        options?: never;
        head?: never;
        patch: operations["schedules_update_schedule"];
        trace?: never;
    };
    "/api/v1/schedules/{schedule_id}/run-now": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["schedules_run_now"];
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
        CalibrationItem: {
            agreement: number | null;
            kappa: number | null;
            kind: components["schemas"]["CalibrationKind"];
            n_labels: number;
            subject: string;
        };
        CalibrationKind: "probe" | "judge";
        CalibrationReport: {
            generated_at: string;
            items: components["schemas"]["CalibrationItem"][];
        };
        DashboardInvalidateEvent: {
            payload: components["schemas"]["DashboardInvalidatePayload"];
            run_id: string | null;
            seq: number | null;
            ts: string;
            type: "dashboard.invalidate";
        };
        DashboardInvalidatePayload: Record<string, never>;
        DashboardSummary: {
            cost_week_usd: number;
            kappa: number | null;
            last_nightly: components["schemas"]["LastNightly"] | null;
            last_runs: Known["schemas"]["RunSummary"][];
            open_findings_by_severity: components["schemas"]["SeverityCounts"];
            suite_power: number | null;
        };
        HooksPromptParams: {
            bundle_id: string;
            template_name: "hooks";
        };
        LastNightly: {
            finished_at: string;
            pass_hat_k: number | null;
            run_id: string;
        };
        Mutant: {
            base_url: string | null;
            branch: string;
            created_at: string;
            description: string;
            expected_catchers: string[];
            id: string;
            last_outcome: components["schemas"]["MutationOutcome"] | null;
            name: string;
            status: components["schemas"]["MutantStatus"];
            target_id: string;
        };
        MutantCreate: {
            base_url?: string | null;
            branch: string;
            description: string;
            expected_catchers: string[];
            name: string;
            target_id: string;
        };
        MutantPage: {
            items: components["schemas"]["Mutant"][];
            next_cursor: string | null;
            total: number | null;
        };
        MutantStatus: "registered" | "deployed" | "retired";
        MutantUpdate: {
            base_url?: string | null;
            branch?: string | null;
            description?: string | null;
            expected_catchers?: string[] | null;
            name?: string | null;
            status?: components["schemas"]["MutantStatus"] | null;
        };
        MutantsPromptParams: {
            invariant_ids: string[];
            template_name: "mutants";
        };
        MutationInvariantPower: {
            invariant_id: string;
            killed: number;
            survived: number;
        };
        MutationOutcome: "killed" | "survived" | "errored" | "skipped";
        MutationOutcomeEvent: {
            payload: components["schemas"]["MutationOutcomePayload"];
            run_id: string | null;
            seq: number | null;
            ts: string;
            type: "mutation.outcome";
        };
        MutationOutcomeItem: {
            caught_by: string[];
            invariant_id: string;
            outcome: components["schemas"]["MutationOutcome"];
        };
        MutationOutcomePayload: {
            caught_by: string[];
            invariant_id: string;
            mutation_run_id: string;
            outcome: components["schemas"]["MutationOutcome"];
        };
        MutationRun: {
            finished_at: string | null;
            id: string;
            mutant_id: string;
            outcomes: components["schemas"]["MutationOutcomeItem"][];
            plan_id: string;
            power: number | null;
            run_id: string;
            started_at: string;
            status: Known["schemas"]["RunStatus"];
        };
        MutationRunCreate: {
            base_url_override?: string | null;
            mutant_id: string;
            plan_id: string;
            target_id: string;
        };
        MutationRunPage: {
            items: components["schemas"]["MutationRun"][];
            next_cursor: string | null;
            total: number | null;
        };
        MutationSummary: {
            killed: number;
            per_invariant: components["schemas"]["MutationInvariantPower"][];
            suite_power: number;
            survivors: components["schemas"]["MutationSurvivor"][];
            total: number;
        };
        MutationSurvivor: {
            invariant_ids: string[];
            mutant_id: string;
            name: string;
        };
        Notification: {
            body: string;
            created_at: string;
            id: string;
            kind: components["schemas"]["NotificationKind"];
            link: string;
            read_at: string | null;
            run_id: string | null;
            severity: P5["schemas"]["Severity"];
            title: string;
        };
        NotificationCreatedEvent: {
            payload: components["schemas"]["NotificationCreatedPayload"];
            run_id: string | null;
            seq: number | null;
            ts: string;
            type: "notification.created";
        };
        NotificationCreatedPayload: {
            kind: components["schemas"]["NotificationKind"];
            link: string;
            notification_id: string;
            severity: P5["schemas"]["Severity"];
            title: string;
        };
        NotificationKind: "run_finished" | "nightly_summary" | "finding_regression" | "budget_exceeded" | "mutant_survived" | "schedule_failed";
        NotificationPage: {
            items: components["schemas"]["Notification"][];
            next_cursor: string | null;
            total: number | null;
        };
        RunReport: {
            config_snapshot: Known["schemas"]["RunConfigSnapshot"];
            diff: P5["schemas"]["RunDiff"] | null;
            findings: P5["schemas"]["FindingSummary"][];
            generated_at: string;
            run: Known["schemas"]["Run"];
            stats: P5["schemas"]["RunStats"];
        };
        Schedule: {
            budget: Known["schemas"]["Budget"] | null;
            cron: string | null;
            enabled: boolean;
            id: string;
            last_run_id: string | null;
            next_run_at: string | null;
            notify: components["schemas"]["ScheduleNotify"];
            plan_id: string;
            temporal_schedule_id: string;
            tier: components["schemas"]["ScheduleTier"];
            timezone: string;
        };
        ScheduleCreate: {
            budget?: Known["schemas"]["Budget"] | null;
            cron?: string | null;
            enabled: boolean;
            notify: components["schemas"]["ScheduleNotify"];
            plan_id: string;
            tier: components["schemas"]["ScheduleTier"];
            timezone: string;
        };
        ScheduleNotify: {
            email: string[];
            slack: boolean;
        };
        SchedulePage: {
            items: components["schemas"]["Schedule"][];
            next_cursor: string | null;
            total: number | null;
        };
        ScheduleTier: "commit" | "nightly" | "weekly";
        ScheduleUpdate: {
            budget?: Known["schemas"]["Budget"] | null;
            cron?: string | null;
            enabled?: boolean | null;
            notify?: components["schemas"]["ScheduleNotify"] | null;
            tier?: components["schemas"]["ScheduleTier"] | null;
            timezone?: string | null;
        };
        SeverityCounts: {
            critical: number;
            high: number;
            info: number;
            low: number;
            medium: number;
        };
        Stage8StreamEvent: components["schemas"]["MutationOutcomeEvent"] | components["schemas"]["NotificationCreatedEvent"] | components["schemas"]["DashboardInvalidateEvent"];
    };
    responses: never;
    parameters: never;
    requestBodies: never;
    headers: never;
    pathItems: never;
}

export type $defs = Record<string, never>;

export interface operations {
    calibration_read_report: {
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
                    "application/json": components["schemas"]["CalibrationReport"];
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
    dashboard_read_dashboard: {
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
                    "application/json": components["schemas"]["DashboardSummary"];
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
    feeds_stream_home_feed: {
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
    mutants_list_mutants: {
        parameters: {
            query?: {
                target_id?: string | null;
                status?: components["schemas"]["MutantStatus"][] | null;
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
                    "application/json": components["schemas"]["MutantPage"];
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
    mutants_create_mutant: {
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
                "application/json": components["schemas"]["MutantCreate"];
            };
        };
        responses: {
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Mutant"];
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
    mutants_delete_mutant: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                mutant_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
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
    mutants_update_mutant: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                mutant_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["MutantUpdate"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Mutant"];
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
    mutation_list_mutation_runs: {
        parameters: {
            query?: {
                target_id?: string | null;
                mutant_id?: string | null;
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
                    "application/json": components["schemas"]["MutationRunPage"];
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
    mutation_create_mutation_run: {
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
                "application/json": components["schemas"]["MutationRunCreate"];
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
    mutation_read_mutation_run: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                mutation_run_id: string;
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
                    "application/json": components["schemas"]["MutationRun"];
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
    mutation_read_summary: {
        parameters: {
            query: {
                target_id: string;
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
                    "application/json": components["schemas"]["MutationSummary"];
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
    notifications_list_notifications: {
        parameters: {
            query?: {
                unread?: boolean | null;
                kind?: components["schemas"]["NotificationKind"][] | null;
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
                    "application/json": components["schemas"]["NotificationPage"];
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
    notifications_mark_all_read: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
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
    notifications_mark_read: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                notification_id: string;
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
                    "application/json": components["schemas"]["Notification"];
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
    runs_read_run_report: {
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
                    "application/json": components["schemas"]["RunReport"];
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
    runs_read_run_report_html: {
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
                    "text/html": string;
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
    schedules_list_schedules: {
        parameters: {
            query?: {
                plan_id?: string | null;
                tier?: components["schemas"]["ScheduleTier"][] | null;
                enabled?: boolean | null;
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
                    "application/json": components["schemas"]["SchedulePage"];
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
    schedules_create_schedule: {
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
                "application/json": components["schemas"]["ScheduleCreate"];
            };
        };
        responses: {
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Schedule"];
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
    schedules_read_schedule: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                schedule_id: string;
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
                    "application/json": components["schemas"]["Schedule"];
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
    schedules_delete_schedule: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                schedule_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
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
    schedules_update_schedule: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                schedule_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ScheduleUpdate"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Schedule"];
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
    schedules_run_now: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": string;
            };
            path: {
                schedule_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
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
}
