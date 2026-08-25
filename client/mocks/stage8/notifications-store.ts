import type {
  Notification as AppNotification,
  NotificationKind,
  Severity,
} from "@/lib/api/types";
import { stableId } from "../stage2/ids";
import { STAGE_TWO_IDS } from "../stage2/seed-ids";

export const NOTIFICATION_SEEDS = ["default", "empty", "many", "unsafe_links"] as const;

export type NotificationsSeed = (typeof NOTIFICATION_SEEDS)[number];

export interface NotificationInput {
  kind: NotificationKind;
  severity: Severity;
  title: string;
  body: string;
  link: string;
  runId: string | null;
}

interface SeedRow extends NotificationInput {
  minutesAgo: number;
  read: boolean;
}

const MS_PER_MINUTE = 60_000;
const MANY_COUNT = 45;

const DEFAULT_ROWS: readonly SeedRow[] = [
  {
    kind: "nightly_summary",
    severity: "medium",
    title: "Nightly run finished: 83% pass^k",
    body: "Gracie nightly: 10 of 12 scenarios passed on every attempt. 2 failed.",
    link: `/runs/${STAGE_TWO_IDS.runs.completed}`,
    runId: STAGE_TWO_IDS.runs.completed,
    minutesAgo: 14,
    read: false,
  },
  {
    kind: "mutant_survived",
    severity: "high",
    title: "A known bug slipped through",
    body: "The mutant skip-tenant-filter-on-issue-list survived. No invariant caught it.",
    link: "/mutation",
    runId: null,
    minutesAgo: 95,
    read: false,
  },
  {
    kind: "finding_regression",
    severity: "high",
    title: "A resolved finding came back",
    body: "Wrong open-issue count in Smart Log was resolved last week and failed again.",
    link: "/findings",
    runId: STAGE_TWO_IDS.runs.flaky,
    minutesAgo: 260,
    read: false,
  },
  {
    kind: "budget_exceeded",
    severity: "critical",
    title: "A run stopped at its budget",
    body: "The API sweep run reached its limit of 2 USD and was stopped.",
    link: `/runs/${STAGE_TWO_IDS.runs.budgetExceeded}`,
    runId: STAGE_TWO_IDS.runs.budgetExceeded,
    minutesAgo: 1500,
    read: true,
  },
  {
    kind: "run_finished",
    severity: "info",
    title: "Run finished",
    body: "Smart Log reads completed with 10 passes and 2 failures.",
    link: `/runs/${STAGE_TWO_IDS.runs.previousCompleted}`,
    runId: STAGE_TWO_IDS.runs.previousCompleted,
    minutesAgo: 2900,
    read: true,
  },
  {
    kind: "schedule_failed",
    severity: "high",
    title: "A scheduled run could not start",
    body: "The nightly schedule for Guest flows failed to create a run: the target was not ready.",
    link: "/settings/schedules",
    runId: null,
    minutesAgo: 4300,
    read: true,
  },
  {
    kind: "budget_exceeded",
    severity: "high",
    title: "A scheduled run was not started",
    body: "A scheduled run for Billing API did not start: the Growth team is over its monthly budget.",
    link: "/settings/teams",
    runId: null,
    minutesAgo: 40,
    read: false,
  },
];

const UNSAFE_ROWS: readonly SeedRow[] = [
  {
    kind: "run_finished",
    severity: "high",
    title: "Link that must not be followed (protocol-relative)",
    body: "The link of this notification starts with two slashes.",
    link: "//evil.example.com/phish",
    runId: null,
    minutesAgo: 3,
    read: false,
  },
  {
    kind: "run_finished",
    severity: "high",
    title: "Link that must not be followed (absolute)",
    body: "The link of this notification is an absolute URL.",
    link: "https://evil.example.com/phish",
    runId: null,
    minutesAgo: 5,
    read: false,
  },
  {
    kind: "run_finished",
    severity: "medium",
    title: "Link that must not be followed (backslash)",
    body: "The link of this notification starts with a slash and a backslash.",
    link: "/\\evil.example.com",
    runId: null,
    minutesAgo: 7,
    read: false,
  },
];

const KIND_CYCLE: readonly NotificationKind[] = [
  "run_finished",
  "nightly_summary",
  "finding_regression",
  "budget_exceeded",
  "mutant_survived",
  "schedule_failed",
];

const SEVERITY_CYCLE: readonly Severity[] = ["info", "medium", "high", "low", "critical"];

function manyRows(): SeedRow[] {
  return Array.from({ length: MANY_COUNT }, (_, index) => ({
    kind: KIND_CYCLE[index % KIND_CYCLE.length] ?? "run_finished",
    severity: SEVERITY_CYCLE[index % SEVERITY_CYCLE.length] ?? "info",
    title: `Notification number ${index + 1}`,
    body: `Generated entry ${index + 1} of ${MANY_COUNT} for the list and the unread count.`,
    link: "/runs",
    runId: null,
    minutesAgo: 10 + index * 7,
    read: index % 3 === 0,
  }));
}

function rowsFor(seed: NotificationsSeed): readonly SeedRow[] {
  switch (seed) {
    case "empty":
      return [];
    case "many":
      return manyRows();
    case "unsafe_links":
      return [...UNSAFE_ROWS, ...DEFAULT_ROWS];
    case "default":
      return DEFAULT_ROWS;
  }
}

export class NotificationsStore {
  private entries: AppNotification[] = [];
  private seedName: NotificationsSeed = "default";
  private seeded = false;
  private liveCounter = 0;

  get currentSeed(): NotificationsSeed {
    return this.seedName;
  }

  reset(seed: NotificationsSeed = "default"): void {
    this.seedName = seed;
    this.seeded = false;
    this.entries = [];
    this.liveCounter = 0;
  }

  private ensure(): void {
    if (this.seeded) {
      return;
    }
    this.seeded = true;
    const now = Date.now();
    this.entries = rowsFor(this.seedName).map((row, index) => {
      const createdAt = new Date(now - row.minutesAgo * MS_PER_MINUTE).toISOString();
      return {
        id: stableId("notification", this.seedName, index),
        kind: row.kind,
        severity: row.severity,
        title: row.title,
        body: row.body,
        link: row.link,
        run_id: row.runId,
        read_at: row.read ? createdAt : null,
        created_at: createdAt,
      };
    });
  }

  get all(): AppNotification[] {
    this.ensure();
    return this.entries.map((entry) => ({ ...entry }));
  }

  get unreadCount(): number {
    this.ensure();
    return this.entries.filter((entry) => entry.read_at === null).length;
  }

  find(id: string): AppNotification | undefined {
    this.ensure();
    const found = this.entries.find((entry) => entry.id === id);
    return found === undefined ? undefined : { ...found };
  }

  markRead(id: string, atMs: number = Date.now()): AppNotification | undefined {
    this.ensure();
    const index = this.entries.findIndex((entry) => entry.id === id);
    const current = this.entries[index];
    if (current === undefined) {
      return undefined;
    }
    const next: AppNotification = {
      ...current,
      read_at: current.read_at ?? new Date(atMs).toISOString(),
    };
    this.entries[index] = next;
    return { ...next };
  }

  markAllRead(atMs: number = Date.now()): number {
    this.ensure();
    let changed = 0;
    this.entries = this.entries.map((entry) => {
      if (entry.read_at !== null) {
        return entry;
      }
      changed += 1;
      return { ...entry, read_at: new Date(atMs).toISOString() };
    });
    return changed;
  }

  add(input: NotificationInput, atMs: number = Date.now()): AppNotification {
    this.ensure();
    this.liveCounter += 1;
    const created: AppNotification = {
      id: stableId("notification_live", this.liveCounter),
      kind: input.kind,
      severity: input.severity,
      title: input.title,
      body: input.body,
      link: input.link,
      run_id: input.runId,
      read_at: null,
      created_at: new Date(atMs).toISOString(),
    };
    this.entries.push(created);
    return { ...created };
  }
}
