import type { SeverityCounts } from "@/lib/api/types";
import { mockState } from "../state";
import type { CalibrationScenario } from "./calibration-data";
import { HomeBus } from "./home-bus";
import type { MutationScenario } from "./mutation-fixture";
import { NotificationsStore, type NotificationsSeed } from "./notifications-store";

export const HOME_SCENARIOS = ["default", "all_killed", "no_mutants", "no_nightly"] as const;

export type HomeScenario = (typeof HOME_SCENARIOS)[number];

export interface HomeFeedConfig {
  notificationIntervalMs: number;
  invalidateIntervalMs: number;
  findingIntervalMs: number;
  paused: boolean;
}

export const DEFAULT_HOME_FEED_CONFIG: Readonly<HomeFeedConfig> = {
  notificationIntervalMs: 30_000,
  invalidateIntervalMs: 12_000,
  findingIntervalMs: 20_000,
  paused: false,
};

const DEFAULT_SEVERITY_COUNTS: Readonly<SeverityCounts> = {
  critical: 1,
  high: 1,
  medium: 1,
  low: 1,
  info: 1,
};

const MUTATION_SCENARIO_OF: Readonly<Record<HomeScenario, MutationScenario>> = {
  default: "survivor",
  all_killed: "all_killed",
  no_mutants: "none",
  no_nightly: "none",
};

export class StageEightStore {
  readonly bus = new HomeBus();
  readonly notifications = new NotificationsStore();
  feed: HomeFeedConfig = { ...DEFAULT_HOME_FEED_CONFIG };
  severity: SeverityCounts = { ...DEFAULT_SEVERITY_COUNTS };
  notificationCursor = 0;
  private scenarioName: HomeScenario = "default";

  get scenario(): HomeScenario {
    return this.scenarioName;
  }

  get hasNightly(): boolean {
    return this.scenarioName !== "no_nightly";
  }

  get mutationScenario(): MutationScenario {
    return MUTATION_SCENARIO_OF[this.scenarioName];
  }

  get calibrationScenario(): CalibrationScenario {
    return this.scenarioName === "no_nightly" ? "few_labels" : "full";
  }

  get kappa(): number | null {
    return this.scenarioName === "no_nightly" ? null : 0.71;
  }

  bumpSeverity(severity: keyof SeverityCounts): void {
    this.severity = { ...this.severity, [severity]: this.severity[severity] + 1 };
  }

  setScenario(scenario: HomeScenario): void {
    this.scenarioName = scenario;
    this.severity = { ...DEFAULT_SEVERITY_COUNTS };
  }

  reset(): void {
    this.scenarioName = "default";
    this.severity = { ...DEFAULT_SEVERITY_COUNTS };
    this.feed = { ...DEFAULT_HOME_FEED_CONFIG };
    this.notificationCursor = 0;
    this.notifications.reset("default");
  }

  resetNotifications(seed: NotificationsSeed): void {
    this.notifications.reset(seed);
  }
}

export const stageEight = new StageEightStore();

mockState.stageTwo.onReset(() => stageEight.reset());
