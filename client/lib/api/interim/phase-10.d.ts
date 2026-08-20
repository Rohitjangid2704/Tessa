import type { components as Known } from "../schema";

export interface paths {
    "/api/v1/auth/sso/provision": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["auth_provision_sso_user"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/calibration/fit": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["calibration_fit_calibration"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/calibration/fit/{run_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["calibration_read_fit"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/ingest/traffic": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["ingest_ingest_traffic"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/labels/export": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["labels_export_labels"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/settings/retention": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["settings_read_retention"];
        put: operations["settings_set_retention"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/teams": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["teams_list_teams"];
        put?: never;
        post: operations["teams_create_team"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/teams/{team_id}": {
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
        patch: operations["teams_update_team"];
        trace?: never;
    };
    "/api/v1/teams/{team_id}/budget": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put: operations["teams_set_team_budget"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/teams/{team_id}/members": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put: operations["teams_set_team_members"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/users": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["users_list_users"];
        put?: never;
        post: operations["users_create_user"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/users/{user_id}": {
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
        patch: operations["users_update_user"];
        trace?: never;
    };
}

export type webhooks = Record<string, never>;

export interface components {
    schemas: {
        CalibrationFit: {
            adopted: boolean;
            created_at: string;
            held_out: components["schemas"]["CalibrationHeldOut"] | null;
            probe_bank_version: string | null;
            run_id: string;
            status: Known["schemas"]["RunStatus"];
            target_id: string | null;
            temperatures: {
                [key: string]: number;
            };
            thresholds: components["schemas"]["CalibrationThresholds"] | null;
        };
        CalibrationFitCreate: {
            target_id?: string | null;
        };
        CalibrationHeldOut: {
            kappa_after: number | null;
            kappa_before: number | null;
            n_labels: number;
        };
        CalibrationThresholds: {
            judge_escalate_below: number;
            probe_confidence: number;
        };
        DashboardLiveProbes: {
            live_probes: components["schemas"]["LiveProbes"] | null;
        };
        LiveProbeStat: {
            n: number;
            pass_rate: number | null;
            probe_id: string;
            uncertain_rate: number | null;
        };
        LiveProbes: {
            by_probe: components["schemas"]["LiveProbeStat"][];
            last_ingested_at: string | null;
            window_hours: number;
        };
        RetentionPolicy: {
            artifacts_days: number;
            run_events_days: number;
            steps_days: number;
        };
        RetentionState: {
            last_sweep: components["schemas"]["RetentionSweepResult"] | null;
            policy: components["schemas"]["RetentionPolicy"];
        };
        RetentionSweepResult: {
            at: string;
            deleted_artifacts: number;
            deleted_events: number;
            deleted_steps: number;
        };
        SsoProvisionRequest: {
            claims: {
                [key: string]: unknown;
            };
            email: string;
            issuer: string;
            name?: string | null;
            subject: string;
        };
        TargetTeamFields: {
            allow_jev: boolean;
            team_id: string | null;
        };
        TargetUpdateTeamFields: {
            allow_jev?: boolean | null;
            team_id?: string | null;
        };
        Team: {
            id: string;
            max_usd_month: number | null;
            member_count: number;
            name: string;
            spent_month_usd: number;
        };
        TeamBudget: {
            max_usd_month: number;
            month: string;
            spent_month_usd: number;
            team_id: string;
        };
        TeamBudgetSet: {
            max_usd_month: number;
        };
        TeamCreate: {
            name: string;
        };
        TeamMembersSet: {
            user_ids: string[];
        };
        TeamPage: {
            items: components["schemas"]["Team"][];
            next_cursor: string | null;
            total: number | null;
        };
        TeamUpdate: {
            name?: string | null;
        };
        TrafficBatch: {
            items: components["schemas"]["TrafficItem"][];
            target_id: string;
        };
        TrafficIngestResult: {
            accepted: number;
            batch_id: string;
            rejected: number;
        };
        TrafficItem: {
            answer: string;
            meta: {
                [key: string]: unknown;
            };
            question: string;
            ts: string;
        };
        User: {
            created_at: string;
            email: string;
            id: string;
            is_active: boolean;
            last_login_at: string | null;
            name: string;
            role: Known["schemas"]["UserRole"];
            team_ids: string[];
        };
        UserCreate: {
            email: string;
            name: string;
            password?: string | null;
            role: Known["schemas"]["UserRole"];
        };
        UserPage: {
            items: components["schemas"]["User"][];
            next_cursor: string | null;
            total: number | null;
        };
        UserUpdate: {
            is_active?: boolean | null;
            name?: string | null;
            role?: Known["schemas"]["UserRole"] | null;
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
    auth_provision_sso_user: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SsoProvisionRequest"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": Known["schemas"]["AuthUser"];
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
    calibration_fit_calibration: {
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
                "application/json": components["schemas"]["CalibrationFitCreate"];
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
    calibration_read_fit: {
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
                    "application/json": components["schemas"]["CalibrationFit"];
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
    ingest_ingest_traffic: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["TrafficBatch"];
            };
        };
        responses: {
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["TrafficIngestResult"];
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
            413: {
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
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": Known["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    labels_export_labels: {
        parameters: {
            query?: {
                min_count?: number | null;
                format?: string | null;
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
                    "application/x-ndjson": string;
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
    settings_read_retention: {
        parameters: {
            query?: never;
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
                    "application/json": components["schemas"]["RetentionState"];
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
    settings_set_retention: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["RetentionPolicy"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RetentionPolicy"];
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
    teams_list_teams: {
        parameters: {
            query?: {
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
                    "application/json": components["schemas"]["TeamPage"];
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
    teams_create_team: {
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
                "application/json": components["schemas"]["TeamCreate"];
            };
        };
        responses: {
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Team"];
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
        };
    };
    teams_update_team: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                team_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["TeamUpdate"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Team"];
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
    teams_set_team_budget: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                team_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["TeamBudgetSet"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["TeamBudget"];
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
    teams_set_team_members: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                team_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["TeamMembersSet"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Team"];
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
    users_list_users: {
        parameters: {
            query?: {
                q?: string | null;
                role?: Known["schemas"]["UserRole"][] | null;
                is_active?: boolean | null;
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
                    "application/json": components["schemas"]["UserPage"];
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
    users_create_user: {
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
                "application/json": components["schemas"]["UserCreate"];
            };
        };
        responses: {
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["User"];
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
        };
    };
    users_update_user: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                user_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["UserUpdate"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["User"];
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
}
