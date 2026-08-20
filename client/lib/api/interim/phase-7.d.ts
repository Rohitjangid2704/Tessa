import type { components as Known } from "../schema";

export interface paths {
    "/api/v1/attacks": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["redteam_list_attacks"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/explorations": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["explorations_create_exploration"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/goals": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["goals_list_goals"];
        put?: never;
        post: operations["goals_create_goal"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/goals/{goal_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["goals_read_goal"];
        put?: never;
        post?: never;
        delete: operations["goals_delete_goal"];
        options?: never;
        head?: never;
        patch: operations["goals_update_goal"];
        trace?: never;
    };
    "/api/v1/personas": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["personas_list_personas"];
        put?: never;
        post: operations["personas_create_persona"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/personas/{persona_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["personas_read_persona"];
        put?: never;
        post?: never;
        delete: operations["personas_delete_persona"];
        options?: never;
        head?: never;
        patch: operations["personas_update_persona"];
        trace?: never;
    };
    "/api/v1/redteam-rounds": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["redteam_list_rounds"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/redteam-runs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["redteam_create_redteam_run"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/redteam/families": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["redteam_list_families"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/replays": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["replays_list_replays"];
        put?: never;
        post: operations["replays_create_replay"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/replays/{replay_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["replays_read_replay"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/replays/{replay_id}/records": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["replays_list_records"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/runs/{run_id}/stop": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["runs_stop_run"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/sim-sessions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["sim_sessions_list_sessions"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/sim-sessions/{sim_session_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["sim_sessions_read_session"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/simulations": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["simulations_create_simulation"];
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
        Attack: {
            family: string;
            finding_id: string | null;
            id: string;
            outcome: components["schemas"]["AttackOutcome"];
            prompt_excerpt: string;
            response_excerpt: string;
            round_id: string;
            skeptic_verdict: Known["schemas"]["Verdict"] | null;
        };
        AttackOutcome: "blocked" | "breached" | "inconclusive";
        AttackPage: {
            items: components["schemas"]["Attack"][];
            next_cursor: string | null;
            total: number | null;
        };
        ExplorationCreate: {
            budget: Known["schemas"]["Budget"];
            goal_id?: string | null;
            goal_kind?: components["schemas"]["GoalKind"] | null;
            goal_text?: string | null;
            max_steps?: number | null;
            role: string;
            target_id: string;
        };
        ExploreActionEvent: {
            payload: components["schemas"]["ExploreActionPayload"];
            run_id: string | null;
            seq: number | null;
            ts: string;
            type: "explore.action";
        };
        ExploreActionKind: "navigate" | "click" | "type" | "read" | "finish";
        ExploreActionPayload: {
            action: components["schemas"]["ExploreActionKind"];
            index: number;
            rationale: string;
            target: string | null;
            text: string | null;
            url: string | null;
        };
        ExploreCandidateEvent: {
            payload: components["schemas"]["ExploreCandidatePayload"];
            run_id: string | null;
            seq: number | null;
            ts: string;
            type: "explore.candidate";
        };
        ExploreCandidatePayload: {
            candidate_id: string;
            description: string;
            from_index: number;
            to_index: number;
        };
        ExploreVerifiedEvent: {
            payload: components["schemas"]["ExploreVerifiedPayload"];
            run_id: string | null;
            seq: number | null;
            ts: string;
            type: "explore.verified";
        };
        ExploreVerifiedPayload: {
            candidate_id: string;
            finding_id: string | null;
            replay_run_scenario_id: string | null;
            verified: boolean;
        };
        Goal: {
            id: string;
            kind: components["schemas"]["GoalKind"];
            role: string | null;
            statement: string;
            success_criteria: string[];
            target_id: string;
            title: string;
        };
        GoalCreate: {
            kind: components["schemas"]["GoalKind"];
            role?: string | null;
            statement: string;
            success_criteria: string[];
            target_id: string;
            title: string;
        };
        GoalKind: "reach_state" | "extract_fact" | "attempt_forbidden" | "complete_flow";
        GoalPage: {
            items: components["schemas"]["Goal"][];
            next_cursor: string | null;
            total: number | null;
        };
        GoalUpdate: {
            kind?: components["schemas"]["GoalKind"] | null;
            role?: string | null;
            statement?: string | null;
            success_criteria?: string[] | null;
            title?: string | null;
        };
        Persona: {
            created_by: string;
            description: string;
            id: string;
            name: string;
            target_id: string;
            traits: {
                [key: string]: unknown;
            };
        };
        PersonaCreate: {
            description: string;
            name: string;
            target_id: string;
            traits: {
                [key: string]: unknown;
            };
        };
        PersonaPage: {
            items: components["schemas"]["Persona"][];
            next_cursor: string | null;
            total: number | null;
        };
        PersonaUpdate: {
            description?: string | null;
            name?: string | null;
            traits?: {
                [key: string]: unknown;
            } | null;
        };
        RedTeamCreate: {
            budget: Known["schemas"]["Budget"];
            families: string[];
            max_rounds?: number | null;
            role: string;
            target_id: string;
        };
        RedTeamFamily: {
            description: string;
            id: string;
            title: string;
        };
        RedTeamFamilyList: {
            items: components["schemas"]["RedTeamFamily"][];
        };
        RedTeamRound: {
            attacks: number;
            candidates: number;
            dry: boolean;
            family: string;
            finished_at: string | null;
            id: string;
            index: number;
            run_id: string;
            started_at: string;
        };
        RedTeamRoundPage: {
            items: components["schemas"]["RedTeamRound"][];
            next_cursor: string | null;
            total: number | null;
        };
        RedteamAttackEvent: {
            payload: components["schemas"]["RedteamAttackPayload"];
            run_id: string | null;
            seq: number | null;
            ts: string;
            type: "redteam.attack";
        };
        RedteamAttackPayload: {
            attack_id: string;
            family: string;
            outcome: components["schemas"]["AttackOutcome"];
            round_id: string;
        };
        RedteamRoundFinishedEvent: {
            payload: components["schemas"]["RedteamRoundFinishedPayload"];
            run_id: string | null;
            seq: number | null;
            ts: string;
            type: "redteam.round_finished";
        };
        RedteamRoundFinishedPayload: {
            attacks: number;
            candidates: number;
            dry: boolean;
            index: number;
            round_id: string;
        };
        RedteamRoundStartedEvent: {
            payload: components["schemas"]["RedteamRoundStartedPayload"];
            run_id: string | null;
            seq: number | null;
            ts: string;
            type: "redteam.round_started";
        };
        RedteamRoundStartedPayload: {
            family: string;
            index: number;
            round_id: string;
        };
        Replay: {
            cases_created: number;
            cases_rejected: number;
            created_at: string;
            id: string;
            records_total: number;
            run_id: string;
            source_name: string;
            status: Known["schemas"]["RunStatus"];
            target_id: string;
        };
        ReplayCreateForm: {
            file: string;
            note?: string | null;
            target_id: string;
        };
        ReplayPage: {
            items: components["schemas"]["Replay"][];
            next_cursor: string | null;
            total: number | null;
        };
        ReplayProgressEvent: {
            payload: components["schemas"]["ReplayProgressPayload"];
            run_id: string | null;
            seq: number | null;
            ts: string;
            type: "replay.progress";
        };
        ReplayProgressPayload: {
            cases_created: number;
            cases_rejected: number;
            records_total: number;
            replay_id: string;
        };
        ReplayReasonCode: "duplicate" | "unstable" | "invalid" | "over_record_cap" | "validation_failed";
        ReplayRecord: {
            excerpt: string;
            id: string;
            index: number;
            reason: string | null;
            reason_code: components["schemas"]["ReplayReasonCode"] | null;
            replay_id: string;
            scenario_id: string | null;
            status: components["schemas"]["ReplayRecordStatus"];
        };
        ReplayRecordPage: {
            items: components["schemas"]["ReplayRecord"][];
            next_cursor: string | null;
            total: number | null;
        };
        ReplayRecordStatus: "pending" | "created" | "rejected";
        RunStopRequestedEvent: {
            payload: components["schemas"]["RunStopRequestedPayload"];
            run_id: string | null;
            seq: number | null;
            ts: string;
            type: "run.stop_requested";
        };
        RunStopRequestedPayload: {
            requested_by: string;
        };
        SimCheckedEvent: {
            payload: components["schemas"]["SimCheckedPayload"];
            run_id: string | null;
            seq: number | null;
            ts: string;
            type: "sim.checked";
        };
        SimCheckedPayload: {
            checks: components["schemas"]["SimChecks"];
            sim_session_id: string;
            verdict: Known["schemas"]["Verdict"];
        };
        SimChecks: {
            calls: Known["schemas"]["VerdictStatus"];
            dialogue: Known["schemas"]["VerdictStatus"];
            end_state: Known["schemas"]["VerdictStatus"];
            goal: Known["schemas"]["VerdictStatus"];
            invariants: Known["schemas"]["VerdictStatus"];
        };
        SimSession: {
            attempt: number;
            checks: components["schemas"]["SimChecks"];
            goal_id: string;
            id: string;
            persona_id: string;
            run_id: string;
            transcript: components["schemas"]["SimTranscriptTurn"][];
            verdict: Known["schemas"]["Verdict"];
        };
        SimSessionPage: {
            items: components["schemas"]["SimSession"][];
            next_cursor: string | null;
            total: number | null;
        };
        SimSpeaker: "persona" | "target";
        SimTranscriptTurn: {
            speaker: components["schemas"]["SimSpeaker"];
            text: string;
            turn: number;
        };
        SimTurnEvent: {
            payload: components["schemas"]["SimTurnPayload"];
            run_id: string | null;
            seq: number | null;
            ts: string;
            type: "sim.turn";
        };
        SimTurnPayload: {
            sim_session_id: string;
            speaker: components["schemas"]["SimSpeaker"];
            text_preview: string;
            turn: number;
        };
        SimulationCreate: {
            budget: Known["schemas"]["Budget"];
            goal_id: string;
            k: number;
            persona_id: string;
            role: string;
            target_id: string;
        };
        Stage7StreamEvent: components["schemas"]["ExploreActionEvent"] | components["schemas"]["ExploreCandidateEvent"] | components["schemas"]["ExploreVerifiedEvent"] | components["schemas"]["SimTurnEvent"] | components["schemas"]["SimCheckedEvent"] | components["schemas"]["RedteamRoundStartedEvent"] | components["schemas"]["RedteamAttackEvent"] | components["schemas"]["RedteamRoundFinishedEvent"] | components["schemas"]["ReplayProgressEvent"] | components["schemas"]["RunStopRequestedEvent"];
    };
    responses: never;
    parameters: never;
    requestBodies: never;
    headers: never;
    pathItems: never;
}

export type $defs = Record<string, never>;

export interface operations {
    redteam_list_attacks: {
        parameters: {
            query?: {
                run_id?: string | null;
                round_id?: string | null;
                outcome?: components["schemas"]["AttackOutcome"][] | null;
                family?: string[] | null;
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
                    "application/json": components["schemas"]["AttackPage"];
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
    explorations_create_exploration: {
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
                "application/json": components["schemas"]["ExplorationCreate"];
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
    goals_list_goals: {
        parameters: {
            query?: {
                target_id?: string | null;
                kind?: components["schemas"]["GoalKind"][] | null;
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
                    "application/json": components["schemas"]["GoalPage"];
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
    goals_create_goal: {
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
                "application/json": components["schemas"]["GoalCreate"];
            };
        };
        responses: {
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Goal"];
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
    goals_read_goal: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                goal_id: string;
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
                    "application/json": components["schemas"]["Goal"];
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
    goals_delete_goal: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                goal_id: string;
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
    goals_update_goal: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                goal_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["GoalUpdate"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Goal"];
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
    personas_list_personas: {
        parameters: {
            query?: {
                target_id?: string | null;
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
                    "application/json": components["schemas"]["PersonaPage"];
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
    personas_create_persona: {
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
                "application/json": components["schemas"]["PersonaCreate"];
            };
        };
        responses: {
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Persona"];
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
    personas_read_persona: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                persona_id: string;
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
                    "application/json": components["schemas"]["Persona"];
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
    personas_delete_persona: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                persona_id: string;
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
    personas_update_persona: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                persona_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PersonaUpdate"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Persona"];
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
    redteam_list_rounds: {
        parameters: {
            query?: {
                run_id?: string | null;
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
                    "application/json": components["schemas"]["RedTeamRoundPage"];
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
    redteam_create_redteam_run: {
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
                "application/json": components["schemas"]["RedTeamCreate"];
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
    redteam_list_families: {
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
                    "application/json": components["schemas"]["RedTeamFamilyList"];
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
    replays_list_replays: {
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
                    "application/json": components["schemas"]["ReplayPage"];
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
    replays_create_replay: {
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
                "multipart/form-data": components["schemas"]["ReplayCreateForm"];
            };
        };
        responses: {
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Replay"];
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
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": Known["schemas"]["ErrorResponse"];
                };
            };
            415: {
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
    replays_read_replay: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                replay_id: string;
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
                    "application/json": components["schemas"]["Replay"];
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
    replays_list_records: {
        parameters: {
            query?: {
                status?: components["schemas"]["ReplayRecordStatus"][] | null;
                reason_code?: components["schemas"]["ReplayReasonCode"][] | null;
                limit?: number;
                cursor?: string | null;
                include_total?: boolean;
                sort?: string | null;
            };
            header?: never;
            path: {
                replay_id: string;
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
                    "application/json": components["schemas"]["ReplayRecordPage"];
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
    runs_stop_run: {
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
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": Known["schemas"]["Run"];
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
    sim_sessions_list_sessions: {
        parameters: {
            query?: {
                run_id?: string | null;
                persona_id?: string | null;
                goal_id?: string | null;
                verdict?: Known["schemas"]["VerdictStatus"][] | null;
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
                    "application/json": components["schemas"]["SimSessionPage"];
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
    sim_sessions_read_session: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                sim_session_id: string;
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
                    "application/json": components["schemas"]["SimSession"];
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
    simulations_create_simulation: {
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
                "application/json": components["schemas"]["SimulationCreate"];
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
}
