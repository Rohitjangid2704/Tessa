import { z } from "zod";

export const DEPENDENCY_NAMES = ["db", "temporal", "laya"] as const;

export type DependencyName = (typeof DEPENDENCY_NAMES)[number];

export const ONE_SHOT_FAULTS = [
  "ws_close_4413",
  "ws_gap",
  "token_expired_once",
  "artifact_expired",
  "budget_exhausted",
  "feed_drop",
] as const;

export type OneShotFault = (typeof ONE_SHOT_FAULTS)[number];

const MAX_ONE_SHOT_COUNT = 1000;
const MAX_LATENCY_MS = 30_000;

export const HEALTH_SLOW_DEFAULT_MS = 3000;

export const SERVICE_TEST_NAMES = [
  "laya",
  "openai",
  "anthropic",
  "jev",
  "temporal",
  "slack",
  "smtp",
] as const;

export type ServiceTestName = (typeof SERVICE_TEST_NAMES)[number];

const oneShotValue = z.union([z.boolean(), z.number().int().min(0).max(MAX_ONE_SHOT_COUNT)]);
const delayValue = z.union([z.boolean(), z.number().int().min(0).max(MAX_LATENCY_MS)]);

export const faultPatchSchema = z.strictObject({
  ws_close_4413: oneShotValue.nullable().optional(),
  ws_gap: oneShotValue.nullable().optional(),
  token_expired_once: oneShotValue.nullable().optional(),
  artifact_expired: oneShotValue.nullable().optional(),
  budget_exhausted: oneShotValue.nullable().optional(),
  feed_drop: oneShotValue.nullable().optional(),
  verdict_flaky: z.boolean().nullable().optional(),
  verify_429: z.boolean().nullable().optional(),
  dependencies_down: z
    .union([z.boolean(), z.array(z.enum(DEPENDENCY_NAMES))])
    .nullable()
    .optional(),
  hello_503: z.boolean().nullable().optional(),
  health_slow: delayValue.nullable().optional(),
  upload_413: z.boolean().nullable().optional(),
  label_replaced_200: z.boolean().nullable().optional(),
  settings_422: z.boolean().nullable().optional(),
  service_test_fail: z
    .union([z.boolean(), z.array(z.enum(SERVICE_TEST_NAMES))])
    .nullable()
    .optional(),
  oracle_error: z.boolean().nullable().optional(),
  seed_mismatch: z.boolean().nullable().optional(),
  production_target: z.boolean().nullable().optional(),
  skeptic_not_independent: z.boolean().nullable().optional(),
  production_blocked: z.boolean().nullable().optional(),
  run_not_stoppable: z.boolean().nullable().optional(),
  latency_ms: z.number().int().min(0).max(MAX_LATENCY_MS).nullable().optional(),
});

export type FaultPatch = z.infer<typeof faultPatchSchema>;

export interface FaultSnapshot {
  ws_close_4413: number;
  ws_gap: number;
  token_expired_once: number;
  artifact_expired: number;
  budget_exhausted: number;
  feed_drop: number;
  verdict_flaky: boolean;
  verify_429: boolean;
  dependencies_down: DependencyName[];
  hello_503: boolean;
  health_slow: number;
  upload_413: boolean;
  label_replaced_200: boolean;
  settings_422: boolean;
  service_test_fail: ServiceTestName[];
  oracle_error: boolean;
  seed_mismatch: boolean;
  production_target: boolean;
  skeptic_not_independent: boolean;
  production_blocked: boolean;
  run_not_stoppable: boolean;
  latency_ms: number;
}

function toCount(value: boolean | number | null | undefined): number {
  if (value === true) {
    return 1;
  }
  if (typeof value === "number") {
    return value;
  }
  return 0;
}

function toDelayMs(value: boolean | number | null | undefined): number {
  if (value === true) {
    return HEALTH_SLOW_DEFAULT_MS;
  }
  return typeof value === "number" ? value : 0;
}

function toDependencies(value: boolean | DependencyName[] | null | undefined): DependencyName[] {
  if (value === true) {
    return [...DEPENDENCY_NAMES];
  }
  if (Array.isArray(value)) {
    return [...value];
  }
  return [];
}

function toServiceTests(value: boolean | ServiceTestName[] | null | undefined): ServiceTestName[] {
  if (value === true) {
    return [...SERVICE_TEST_NAMES];
  }
  if (Array.isArray(value)) {
    return [...value];
  }
  return [];
}

function emptyFaults(): FaultSnapshot {
  return {
    ws_close_4413: 0,
    ws_gap: 0,
    token_expired_once: 0,
    artifact_expired: 0,
    budget_exhausted: 0,
    feed_drop: 0,
    verdict_flaky: false,
    verify_429: false,
    dependencies_down: [],
    hello_503: false,
    health_slow: 0,
    upload_413: false,
    label_replaced_200: false,
    settings_422: false,
    service_test_fail: [],
    oracle_error: false,
    seed_mismatch: false,
    production_target: false,
    skeptic_not_independent: false,
    production_blocked: false,
    run_not_stoppable: false,
    latency_ms: 0,
  };
}

export class FaultRegistry {
  private state: FaultSnapshot = emptyFaults();

  snapshot(): FaultSnapshot {
    return {
      ...this.state,
      dependencies_down: [...this.state.dependencies_down],
      service_test_fail: [...this.state.service_test_fail],
    };
  }

  reset(): void {
    this.state = emptyFaults();
  }

  apply(patch: FaultPatch): void {
    for (const name of ONE_SHOT_FAULTS) {
      if (patch[name] !== undefined) {
        this.state[name] = toCount(patch[name]);
      }
    }
    if (patch.verdict_flaky !== undefined) {
      this.state.verdict_flaky = patch.verdict_flaky === true;
    }
    if (patch.verify_429 !== undefined) {
      this.state.verify_429 = patch.verify_429 === true;
    }
    if (patch.dependencies_down !== undefined) {
      this.state.dependencies_down = toDependencies(patch.dependencies_down);
    }
    if (patch.hello_503 !== undefined) {
      this.state.hello_503 = patch.hello_503 === true;
    }
    if (patch.health_slow !== undefined) {
      this.state.health_slow = toDelayMs(patch.health_slow);
    }
    if (patch.upload_413 !== undefined) {
      this.state.upload_413 = patch.upload_413 === true;
    }
    if (patch.label_replaced_200 !== undefined) {
      this.state.label_replaced_200 = patch.label_replaced_200 === true;
    }
    if (patch.settings_422 !== undefined) {
      this.state.settings_422 = patch.settings_422 === true;
    }
    if (patch.service_test_fail !== undefined) {
      this.state.service_test_fail = toServiceTests(patch.service_test_fail);
    }
    if (patch.oracle_error !== undefined) {
      this.state.oracle_error = patch.oracle_error === true;
    }
    if (patch.seed_mismatch !== undefined) {
      this.state.seed_mismatch = patch.seed_mismatch === true;
    }
    if (patch.production_target !== undefined) {
      this.state.production_target = patch.production_target === true;
    }
    if (patch.skeptic_not_independent !== undefined) {
      this.state.skeptic_not_independent = patch.skeptic_not_independent === true;
    }
    if (patch.production_blocked !== undefined) {
      this.state.production_blocked = patch.production_blocked === true;
    }
    if (patch.run_not_stoppable !== undefined) {
      this.state.run_not_stoppable = patch.run_not_stoppable === true;
    }
    if (patch.latency_ms !== undefined) {
      this.state.latency_ms = patch.latency_ms ?? 0;
    }
  }

  consume(name: OneShotFault): boolean {
    if (this.state[name] <= 0) {
      return false;
    }
    this.state[name] -= 1;
    return true;
  }

  isDependencyDown(name: DependencyName): boolean {
    return this.state.dependencies_down.includes(name);
  }

  get verdictFlaky(): boolean {
    return this.state.verdict_flaky;
  }

  get verify429(): boolean {
    return this.state.verify_429;
  }

  get hello503(): boolean {
    return this.state.hello_503;
  }

  get healthSlowMs(): number {
    return this.state.health_slow;
  }

  get upload413(): boolean {
    return this.state.upload_413;
  }

  get labelReplaced200(): boolean {
    return this.state.label_replaced_200;
  }

  get settings422(): boolean {
    return this.state.settings_422;
  }

  isServiceTestFailing(name: ServiceTestName): boolean {
    return this.state.service_test_fail.includes(name);
  }

  get oracleError(): boolean {
    return this.state.oracle_error;
  }

  get seedMismatch(): boolean {
    return this.state.seed_mismatch;
  }

  get productionTarget(): boolean {
    return this.state.production_target;
  }

  get skepticNotIndependent(): boolean {
    return this.state.skeptic_not_independent;
  }

  get productionBlocked(): boolean {
    return this.state.production_blocked;
  }

  get runNotStoppable(): boolean {
    return this.state.run_not_stoppable;
  }

  get latencyMs(): number {
    return this.state.latency_ms;
  }
}
