import { ORACLE_MAX_ROWS, type OracleRowsKind } from "../../fixtures/oracle-templates";

export type OracleRow = Record<string, unknown>;

export interface BuiltRows {
  rows: OracleRow[];
  truncated: boolean;
}

const ROOM_TYPES = ["single", "double", "suite"] as const;
const ROOM_STATUSES = ["clean", "dirty", "inspected", "out_of_order"] as const;
const REQUEST_KINDS = [
  "towels",
  "late_checkout",
  "room_service",
  "maintenance",
  "wake_up",
] as const;
const REQUEST_STATES = ["open", "in_progress", "done"] as const;
const LONG_NOTE_REPEATS = 12;
const INVENTORY_ROOMS = 60;
const ROOMS_PER_FLOOR = 10;
const TRUNCATED_TOTAL_ROWS = 230;

function pick<Item>(items: readonly Item[], index: number): Item {
  return items[index % items.length] as Item;
}

function numberOf(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function maintenanceRows(params: Record<string, unknown>): BuiltRows {
  const rows: OracleRow[] = [
    {
      issue_id: 1042,
      room: "412",
      category: "plumbing",
      status: "open",
      opened_at: "2026-09-30T09:12:00.000Z",
      assigned_to: "Maya Rossi",
    },
    {
      issue_id: 1039,
      room: "208",
      category: "hvac",
      status: "open",
      opened_at: "2026-09-29T16:40:00.000Z",
      assigned_to: null,
    },
    {
      issue_id: 1031,
      room: "305",
      category: "<img src=x onerror=alert(1)>",
      status: "open",
      opened_at: "2026-09-28T11:05:00.000Z",
      assigned_to: "Li Wei",
    },
    {
      issue_id: 1027,
      room: "118",
      category: "electrical",
      status: "open",
      opened_at: "2026-09-27T20:31:00.000Z",
      assigned_to: "Jordan Park",
    },
  ];
  const limit = numberOf(params.limit);
  return { rows: limit === null ? rows : rows.slice(0, Math.max(0, limit)), truncated: false };
}

function singleRow(params: Record<string, unknown>): BuiltRows {
  return {
    rows: [
      {
        issue_id: numberOf(params.issue_id) ?? 1042,
        category: "plumbing",
        status: "open",
        description: "Water is leaking under the bathroom sink of room 412",
        opened_at: "2026-09-30T09:12:00.000Z",
        closed_at: null,
      },
    ],
    truncated: false,
  };
}

function inventoryRows(): BuiltRows {
  const rows = Array.from({ length: INVENTORY_ROOMS }, (_, index): OracleRow => {
    const floor = Math.floor(index / ROOMS_PER_FLOOR) + 1;
    return {
      room_number: `${floor}${String((index % ROOMS_PER_FLOOR) + 1).padStart(2, "0")}`,
      floor,
      room_type: pick(ROOM_TYPES, index),
      status: pick(ROOM_STATUSES, index * 7),
    };
  });
  return { rows, truncated: false };
}

function truncatedRows(): BuiltRows {
  const rows = Array.from({ length: ORACLE_MAX_ROWS }, (_, index): OracleRow => {
    const sequence = TRUNCATED_TOTAL_ROWS - index;
    return {
      id: 9000 + sequence,
      room_number: String(100 + (sequence % 60)),
      kind: pick(REQUEST_KINDS, sequence),
      state: pick(REQUEST_STATES, sequence),
      created_at: new Date(Date.UTC(2026, 8, 30, 23, 59) - index * 360_000).toISOString(),
    };
  });
  return { rows, truncated: true };
}

function raggedRows(): BuiltRows {
  return {
    rows: [
      {
        display_name: "Maya Rossi",
        shifts: ["mon 07-15", "tue 07-15"],
        contact: { phone: "555-0100", email: "maya.rossi@gracie.example" },
      },
      { display_name: "Li Wei", shifts: [] },
      {
        display_name: "Jordan <b>Park</b>",
        shifts: ["sat 15-23"],
        contact: null,
        notes: "Prefers early shifts. ".repeat(LONG_NOTE_REPEATS).trim(),
      },
      { display_name: "Sam Okafor", shifts: ["sun 07-15"], badge: 4471 },
    ],
    truncated: false,
  };
}

function occupancyRows(): BuiltRows {
  const rows = Array.from({ length: 8 }, (_, index): OracleRow => {
    const arrivals = 3 + ((index * 5) % 11);
    return {
      hour: `2026-10-01T${String(12 + index).padStart(2, "0")}:00:00.000Z`,
      arrivals,
      late_arrivals: arrivals % 3,
    };
  });
  return { rows, truncated: false };
}

export function buildRows(kind: OracleRowsKind, params: Record<string, unknown>): BuiltRows {
  switch (kind) {
    case "maintenance":
      return maintenanceRows(params);
    case "single":
      return singleRow(params);
    case "inventory":
      return inventoryRows();
    case "truncated":
      return truncatedRows();
    case "ragged":
      return raggedRows();
    case "occupancy":
      return occupancyRows();
    case "empty":
      return { rows: [], truncated: false };
  }
}
