import { createHash } from "node:crypto";
import {
  buildCompleteness,
  buildValidationError,
  type BundleCompleteness,
  type BundleValidationError,
  type CheckOutcome,
  type CompletenessCheckId,
} from "../factories/bundles";
import {
  GRACIE_FEATURES,
  GRACIE_FEATURES_BELOW_BAR,
  GRACIE_INTERFACES,
  GRACIE_ROLES,
  GRACIE_TRUTH_SOURCES,
  type GracieFeature,
} from "../fixtures/gracie-catalog";
import {
  GRACIE_ENVIRONMENT,
  GRACIE_ENVIRONMENT_BELOW_BAR,
  type DeclaredVariable,
} from "../fixtures/gracie-env";
import type { BundleFileRecord, TruthSourceRecord } from "./store";
import { toYaml } from "./yaml";

export const CONTENT_KINDS = ["valid", "below_bar", "invalid", "paste"] as const;

export type ContentKind = (typeof CONTENT_KINDS)[number];

export interface BundleContent {
  kind: ContentKind;
  validationStatus: "valid" | "invalid";
  features: GracieFeature[];
  roles: typeof GRACIE_ROLES;
  interfaces: typeof GRACIE_INTERFACES;
  truthSources: TruthSourceRecord[];
  environment: DeclaredVariable[];
  files: BundleFileRecord[];
  sections: Record<string, unknown>;
  completeness: BundleCompleteness;
  errors: BundleValidationError[];
  warnings: BundleValidationError[];
  hooksMissing: Array<{ id: string; description: string }>;
  hash: string;
}

const KIBIBYTE = 1024;
const MEBIBYTE = KIBIBYTE * KIBIBYTE;
const TRUNCATED_PREVIEW_CHARACTERS = 2000;

const COMPLETENESS_BY_KIND: Record<ContentKind, Record<CompletenessCheckId, CheckOutcome>> = {
  valid: {
    required_sections: { earned: 20 },
    feature_interface_roles: { earned: 15 },
    feature_examples: { earned: 20 },
    oracle_read_only: {
      earned: 10,
      detail: "11 of 15 computable features have a read-only oracle",
      fix_hint: "Add oracle/<name>.sql for access.read.who_am_i and the three job features",
    },
    env_template_coverage: {
      earned: 12,
      detail:
        "2 placeholders are missing from env.template: GRACIE_OPS_HOOK_URL, GRACIE_STRICT_CONFIRMATION",
      fix_hint: "Add one NAME=placeholder line per missing placeholder to env.template",
    },
    seeds_reset_and_hash: { earned: 15 },
  },
  below_bar: {
    required_sections: { earned: 20 },
    feature_interface_roles: {
      earned: 12,
      detail: "3 of 12 features name no role or no interface",
      fix_hint: "Give every feature at least one interface id and one role id",
    },
    feature_examples: {
      earned: 8,
      detail: "3 of 12 features have no concrete example",
      fix_hint: "Add one example with the expected behaviour to each feature without one",
    },
    oracle_read_only: {
      earned: 5,
      detail: "2 of 9 computable features have a read-only oracle",
      fix_hint: "Add oracle/<name>.sql with the sentence template for each computable read",
    },
    env_template_coverage: {
      earned: 10,
      detail: "2 placeholders are missing from env.template",
      fix_hint: "Add one NAME=placeholder line per placeholder used in the manifest",
    },
    seeds_reset_and_hash: {
      earned: 0,
      detail: "No seeds/ folder and no hash command",
      fix_hint: "Add a reset script under seeds/ and a command that prints the state hash",
    },
  },
  paste: {
    required_sections: { earned: 20 },
    feature_interface_roles: { earned: 15 },
    feature_examples: {
      earned: 12,
      detail: "4 of 12 features have no concrete example",
      fix_hint: "Add one example with the expected behaviour to each feature without one",
    },
    oracle_read_only: {
      earned: 0,
      detail: "A pasted manifest carries no oracle files",
      fix_hint: "Upload the zip of tessa/ so the oracle folder is included",
    },
    env_template_coverage: {
      earned: 0,
      detail: "A pasted manifest carries no env.template",
      fix_hint: "Upload the zip of tessa/ so env.template is included",
    },
    seeds_reset_and_hash: {
      earned: 0,
      detail: "A pasted manifest carries no seeds/ folder",
      fix_hint: "Upload the zip of tessa/ so the seeds are included",
    },
  },
  invalid: {
    required_sections: { earned: 0, detail: "The manifest did not validate" },
    feature_interface_roles: { earned: 0, detail: "The manifest did not validate" },
    feature_examples: { earned: 0, detail: "The manifest did not validate" },
    oracle_read_only: { earned: 0, detail: "The manifest did not validate" },
    env_template_coverage: { earned: 0, detail: "The manifest did not validate" },
    seeds_reset_and_hash: { earned: 0, detail: "The manifest did not validate" },
  },
};

const INVALID_ERRORS: BundleValidationError[] = [
  buildValidationError({
    code: "required_property_missing",
    message: "'seeds' is a required property",
    pointer: "/seeds",
    line: 212,
    column: 1,
  }),
  buildValidationError({
    code: "enum_mismatch",
    message: "'kind' must be one of read, write, flow, auth, admin, stream, job",
    pointer: "/features/3/kind",
    line: 71,
    column: 11,
  }),
  buildValidationError({
    code: "unknown_reference",
    message: "Feature 'guest_requests.read.list_open' references unknown interface 'rest'",
    pointer: "/features/5/interfaces/0",
    line: 96,
    column: 9,
  }),
  buildValidationError({
    code: "placeholder_not_in_env_template",
    message: "Placeholder ${GRACIE_API_TOKEN} is not declared in env.template",
    file: "env.template",
    line: 3,
    column: 1,
  }),
  buildValidationError({
    code: "invalid_yaml",
    message: "Mapping values are not allowed here",
    file: "flows/request_and_track.yaml",
    line: 14,
    column: 22,
  }),
];

const IGNORED_FILE_WARNING = buildValidationError({
  code: "file_ignored",
  message: "Non-text entry ignored",
  severity: "warning",
  file: "seeds/dump.bin",
});

const MISSING_ORACLE_WARNING = buildValidationError({
  code: "oracle_missing",
  message:
    "Feature 'access.read.who_am_i' names oracle 'user_by_token' but oracle/ has no such file",
  severity: "warning",
  file: "manifest.yaml",
  pointer: "/features/8/examples/0/oracle",
  line: 188,
  column: 15,
});

const HOOKS_MISSING = [
  { id: "pin_clock", description: "No QA route pins the server clock" },
  { id: "flush_caches", description: "No QA route flushes the response caches" },
];

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function fileRecord(path: string, content: string, claimedBytes?: number): BundleFileRecord {
  const bytes = Buffer.byteLength(content);
  const size = claimedBytes ?? bytes;
  const truncated = size > MEBIBYTE;
  return {
    path,
    content: truncated ? content.slice(0, TRUNCATED_PREVIEW_CHARACTERS) : content,
    size_bytes: size,
    sha256: sha256(content),
    truncated,
  };
}

function envTemplate(variables: readonly DeclaredVariable[]): string {
  return variables
    .map((variable) => `# ${variable.purpose}\n${variable.name}=\${${variable.name}}`)
    .join("\n")
    .concat("\n");
}

function manifestSections(
  kind: ContentKind,
  token: string,
  features: readonly GracieFeature[],
  environment: readonly DeclaredVariable[],
  schemaUrl: string,
): Record<string, unknown> {
  return {
    schema: schemaUrl,
    target_token: token,
    app: {
      name: "Gracie",
      kind: "llm_assistant",
      summary:
        "A voice-first assistant that answers hotel guest questions from live property data.",
    },
    interfaces: GRACIE_INTERFACES.map((entry) => ({ ...entry })),
    roles: GRACIE_ROLES.map((entry) => ({ ...entry })),
    features: features.map((feature) => ({ id: feature.feature_id, ...feature })),
    truth_sources: GRACIE_TRUTH_SOURCES.map((entry) => ({ ...entry })),
    environment: environment.map(({ name, kind: variableKind, required }) => ({
      name,
      kind: variableKind,
      required,
    })),
    test_hooks: { missing: kind === "valid" ? HOOKS_MISSING : [] },
  };
}

function filesFor(
  kind: ContentKind,
  manifestYaml: string,
  environment: readonly DeclaredVariable[],
): BundleFileRecord[] {
  const manifest = fileRecord("manifest.yaml", manifestYaml);
  if (kind === "paste") {
    return [manifest];
  }
  const common = [
    manifest,
    fileRecord("README.md", "# Gracie QA bundle\n\nWritten by Claude Code from the repository.\n"),
    fileRecord("env.template", envTemplate(environment)),
  ];
  if (kind === "below_bar") {
    return [
      ...common,
      fileRecord(
        "oracle/open_maintenance.sql",
        "SELECT count(*) FROM issues WHERE status = 'open';\n",
      ),
    ];
  }
  return [
    ...common,
    fileRecord("seeds/reset.sql", "TRUNCATE guest_requests, smart_log_issues RESTART IDENTITY;\n"),
    fileRecord(
      "seeds/hash.sh",
      'psql "$GRACIE_READONLY_DSN" -Atc "SELECT md5(string_agg(id::text, \',\'))"\n',
    ),
    fileRecord(
      "oracle/open_maintenance.sql",
      "SELECT count(*) AS open_count FROM issues WHERE status = 'open';\n",
    ),
    fileRecord(
      "oracle/open_maintenance.yaml",
      toYaml({
        name: "open_maintenance",
        feature_ids: ["smart_log.read.open_maintenance"],
        language: "sql",
        params_schema: { type: "object", properties: {} },
        sentence_template: "There are {open_count} open maintenance issues.",
      }),
    ),
    fileRecord(
      "flows/request_and_track.yaml",
      toYaml({
        id: "request_and_track",
        title: "Guest raises a request and tracks it",
        feature_ids: ["guest_requests.flow.request_and_track"],
        role: "guest",
        steps: [
          {
            url: "/chat",
            action: "type",
            target: { role: "textbox", name: "Message" },
            expect: {},
          },
        ],
      }),
    ),
    fileRecord("openapi.json", "{}\n", 3 * MEBIBYTE + 512 * KIBIBYTE),
  ];
}

function pickFeatures(kind: ContentKind): GracieFeature[] {
  if (kind === "invalid") {
    return [];
  }
  if (kind === "valid") {
    return [...GRACIE_FEATURES];
  }
  const belowBar = [...GRACIE_FEATURES_BELOW_BAR];
  return kind === "paste" ? belowBar.slice(0, 8) : belowBar;
}

function pickEnvironment(kind: ContentKind): DeclaredVariable[] {
  if (kind === "invalid" || kind === "paste") {
    return [];
  }
  return [...(kind === "valid" ? GRACIE_ENVIRONMENT : GRACIE_ENVIRONMENT_BELOW_BAR)];
}

function pickWarnings(kind: ContentKind): BundleValidationError[] {
  if (kind === "valid") {
    return [IGNORED_FILE_WARNING];
  }
  if (kind === "below_bar") {
    return [IGNORED_FILE_WARNING, MISSING_ORACLE_WARNING];
  }
  return [];
}

export function buildBundleContent(
  kind: ContentKind,
  targetToken: string,
  schemaUrl: string,
): BundleContent {
  const features = pickFeatures(kind);
  const environment = pickEnvironment(kind);
  const sections = manifestSections(kind, targetToken, features, environment, schemaUrl);
  const manifestYaml = kind === "invalid" ? "app: [unclosed\n" : toYaml(sections);
  const files = filesFor(kind, manifestYaml, environment);
  return {
    kind,
    validationStatus: kind === "invalid" ? "invalid" : "valid",
    features,
    roles: GRACIE_ROLES,
    interfaces: GRACIE_INTERFACES,
    truthSources:
      kind === "valid" || kind === "below_bar"
        ? GRACIE_TRUTH_SOURCES.map((entry) => ({ ...entry }))
        : [],
    environment,
    files,
    sections: kind === "invalid" ? {} : sections,
    completeness: buildCompleteness(COMPLETENESS_BY_KIND[kind]),
    errors: kind === "invalid" ? INVALID_ERRORS.map((entry) => ({ ...entry })) : [],
    warnings: pickWarnings(kind),
    hooksMissing: kind === "valid" ? HOOKS_MISSING.map((entry) => ({ ...entry })) : [],
    hash: sha256(`mock-bundle:${kind}`),
  };
}
