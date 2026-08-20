import type { components as Known } from "../schema";

export interface paths {
    "/api/v1/contract-checks": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["contracts_list_contract_checks"];
        put?: never;
        post: operations["contracts_create_contract_check"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/contract-checks/{contract_check_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["contracts_read_contract_check"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/library/bundles": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["library_list_bundles"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/run-groups": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["run_groups_create_run_group"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/run-groups/{run_group_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["run_groups_read_run_group"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/targets/{target_id}/bundle-source": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["bundle_sources_read_bundle_source"];
        put: operations["bundle_sources_set_bundle_source"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/targets/{target_id}/bundle-source/pull": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["bundle_sources_pull_bundle_source"];
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
        AdapterStepRequest: components["schemas"]["WebhookStepRequest"] | components["schemas"]["WebsocketStepRequest"] | components["schemas"]["GraphqlStepRequest"] | components["schemas"]["CliStepRequest"] | components["schemas"]["PipelineStepRequest"];
        AdapterStepResponse: components["schemas"]["WebhookStepResponse"] | components["schemas"]["WebsocketStepResponse"] | components["schemas"]["GraphqlStepResponse"] | components["schemas"]["CliStepResponse"] | components["schemas"]["PipelineStepResponse"];
        BundleImportCreate: {
            ref?: string | null;
        };
        BundleSource: {
            branch: string;
            credential_name: string;
            git_url: string;
            last_pulled_at: string | null;
            last_ref: string | null;
            path: string;
        };
        BundleSourceSet: {
            branch: string;
            credential_name: string;
            git_url: string;
            path?: string | null;
        };
        CliStepRequest: {
            argv: string[];
            cwd: string | null;
            env_names: string[];
            kind: "cli";
        } & {
            [key: string]: unknown;
        };
        CliStepResponse: {
            duration_ms: number;
            exit_code: number;
            kind: "cli";
            stderr: string;
            stdout: string;
            truncated: boolean;
        } & {
            [key: string]: unknown;
        };
        ContractCheck: {
            breaking: number;
            consumer_bundle_id: string;
            created_at: string;
            id: string;
            items: components["schemas"]["ContractDiff"][];
            provider_bundle_id: string;
            run_id: string;
            status: Known["schemas"]["RunStatus"];
        };
        ContractCheckCreate: {
            consumer_bundle_id: string;
            provider_bundle_id: string;
        };
        ContractCheckPage: {
            items: components["schemas"]["ContractCheck"][];
            next_cursor: string | null;
            total: number | null;
        };
        ContractDiff: {
            consumer_declares: {
                [key: string]: unknown;
            };
            interface_id: string;
            message: string;
            path: string;
            provider_accepts: {
                [key: string]: unknown;
            };
            verdict: Known["schemas"]["VerdictStatus"];
        };
        ContractProgressEvent: {
            payload: components["schemas"]["ContractProgressPayload"];
            run_id: string | null;
            seq: number | null;
            ts: string;
            type: "contract.progress";
        };
        ContractProgressPayload: {
            breaking: number;
            contract_check_id: string;
            items_done: number;
            items_total: number;
        };
        GraphqlError: {
            extensions: {
                [key: string]: unknown;
            } | null;
            message: string;
            path: string[] | null;
        };
        GraphqlStepRequest: {
            kind: "graphql";
            operation_name: string | null;
            query: string;
            url: string;
            variables: {
                [key: string]: unknown;
            } | null;
        } & {
            [key: string]: unknown;
        };
        GraphqlStepResponse: {
            data: Known["schemas"]["JsonValue"] | null;
            errors: components["schemas"]["GraphqlError"][];
            kind: "graphql";
            status: number;
        } & {
            [key: string]: unknown;
        };
        LibraryBundle: Known["schemas"]["BundleSummary"] & {
            app_kind: Known["schemas"]["AppKind"];
            target_id: string;
            target_name: string;
        };
        LibraryBundlePage: {
            items: components["schemas"]["LibraryBundle"][];
            next_cursor: string | null;
            total: number | null;
        };
        PipelineOp: "ingest" | "assert_index" | "assert_visibility";
        PipelineStepRequest: {
            kind: "pipeline";
            marker: string;
            op: components["schemas"]["PipelineOp"];
            params: {
                [key: string]: unknown;
            };
            role: string | null;
        } & {
            [key: string]: unknown;
        };
        PipelineStepResponse: {
            expected: {
                [key: string]: unknown;
            } | null;
            kind: "pipeline";
            observed: {
                [key: string]: unknown;
            } | null;
            ok: boolean;
            op: components["schemas"]["PipelineOp"];
        } & {
            [key: string]: unknown;
        };
        RunGroup: {
            created_at: string;
            id: string;
            run_ids: string[];
            status: Known["schemas"]["RunStatus"];
        };
        RunGroupCreate: {
            plan_ids: string[];
        };
        Stage9StreamEvent: components["schemas"]["ContractProgressEvent"];
        WebhookOutboundCall: {
            body: Known["schemas"]["JsonValue"] | null;
            headers: {
                [key: string]: string;
            };
            method: string;
            received_at_ms: number;
            url: string;
        };
        WebhookSignature: {
            header: string;
            scheme: "hmac_sha256";
            signed_payload_sha256: string;
        };
        WebhookStepRequest: {
            body: Known["schemas"]["JsonValue"] | null;
            headers: {
                [key: string]: string;
            };
            kind: "webhook";
            signature: components["schemas"]["WebhookSignature"] | null;
            url: string;
        } & {
            [key: string]: unknown;
        };
        WebhookStepResponse: {
            body: Known["schemas"]["JsonValue"] | null;
            headers: {
                [key: string]: string;
            };
            kind: "webhook";
            outbound_calls: components["schemas"]["WebhookOutboundCall"][];
            status: number;
        } & {
            [key: string]: unknown;
        };
        WebsocketMessage: {
            at_ms: number;
            data: string;
        };
        WebsocketStepRequest: {
            kind: "websocket";
            messages_sent: components["schemas"]["WebsocketMessage"][];
            url: string;
        } & {
            [key: string]: unknown;
        };
        WebsocketStepResponse: {
            close_code: number | null;
            close_reason: string | null;
            kind: "websocket";
            messages_received: components["schemas"]["WebsocketMessage"][];
            truncated: boolean;
        } & {
            [key: string]: unknown;
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
    contracts_list_contract_checks: {
        parameters: {
            query?: {
                consumer_target_id?: string | null;
                provider_target_id?: string | null;
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
                    "application/json": components["schemas"]["ContractCheckPage"];
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
    contracts_create_contract_check: {
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
                "application/json": components["schemas"]["ContractCheckCreate"];
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
    contracts_read_contract_check: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                contract_check_id: string;
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
                    "application/json": components["schemas"]["ContractCheck"];
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
    library_list_bundles: {
        parameters: {
            query?: {
                q?: string | null;
                app_kind?: Known["schemas"]["AppKind"][] | null;
                target_id?: string | null;
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
                    "application/json": components["schemas"]["LibraryBundlePage"];
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
    run_groups_create_run_group: {
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
                "application/json": components["schemas"]["RunGroupCreate"];
            };
        };
        responses: {
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RunGroup"];
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
    run_groups_read_run_group: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                run_group_id: string;
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
                    "application/json": components["schemas"]["RunGroup"];
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
    bundle_sources_read_bundle_source: {
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
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["BundleSource"];
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
    bundle_sources_set_bundle_source: {
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
                "application/json": components["schemas"]["BundleSourceSet"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["BundleSource"];
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
    bundle_sources_pull_bundle_source: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": string;
            };
            path: {
                target_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["BundleImportCreate"];
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
            502: {
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
