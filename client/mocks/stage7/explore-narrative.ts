import { stableUnit } from "../stage2/ids";
import type { ExploreActionKind, FindingClass, Severity } from "@/lib/api/types";

export type NarrativeVariant = "findings" | "clean";

export interface ExplorePage {
  path: string;
  title: string;
  excerpt: string;
}

export interface ExploreMove {
  action: ExploreActionKind;
  target: string | null;
  text: string | null;
  url: string | null;
  rationale: string;
  page: ExplorePage | null;
  replayPage?: ExplorePage;
}

export interface FindingPlan {
  title: string;
  class: FindingClass;
  severity: Severity;
  expected: string;
  actual: string;
}

export interface CandidatePlan {
  key: string;
  description: string;
  fromIndex: number;
  toIndex: number;
  reproduces: boolean;
  finding: FindingPlan | null;
}

export interface ExploreNarrative {
  moves: ExploreMove[];
  candidates: CandidatePlan[];
}

export interface NarrativeInput {
  webBase: string;
  role: string;
  goalText: string;
  variant: NarrativeVariant;
}

const CLEAN_RATE = 0.5;

export function pickVariant(goalKind: string | null, goalText: string): NarrativeVariant {
  if (goalKind === "attempt_forbidden") {
    return "findings";
  }
  return stableUnit("explore_variant", goalText) < CLEAN_RATE ? "clean" : "findings";
}

function humanRole(role: string): string {
  return role.replaceAll("_", " ");
}

function pageOf(path: string, title: string, excerpt: string): ExplorePage {
  return { path, title, excerpt };
}

function movesCommon(input: NarrativeInput): ExploreMove[] {
  const { webBase, role, goalText } = input;
  return [
    {
      action: "navigate",
      target: null,
      text: null,
      url: `${webBase}/dashboard`,
      rationale: `Start on the landing page to see what a ${humanRole(role)} can reach. Goal: ${goalText}`,
      page: pageOf(
        "/dashboard",
        "Dashboard | Gracie",
        "Dashboard. Open issues 7. Guest requests 12. Documents. Reports. Settings.",
      ),
    },
    {
      action: "read",
      target: "navigation",
      text: null,
      url: null,
      rationale: "Read the main navigation to find the areas that could hold private documents.",
      page: pageOf(
        "/dashboard",
        "Dashboard | Gracie",
        "Navigation: Dashboard, Guest requests, Documents, Reports, Settings.",
      ),
    },
    {
      action: "click",
      target: 'link "Documents"',
      text: null,
      url: null,
      rationale: "Documents is the closest area to the goal, so open it first.",
      page: pageOf(
        "/documents",
        "Documents | Gracie",
        "Documents. Shared with the team: Staff handbook, Fire plan. No private documents are listed.",
      ),
    },
  ];
}

function findingsMoves(input: NarrativeInput): ExploreMove[] {
  const { webBase, role } = input;
  return [
    ...movesCommon(input),
    {
      action: "navigate",
      target: null,
      text: null,
      url: `${webBase}/documents/hr-private-1042`,
      rationale:
        "The list shows no private documents. Open a private document address directly to check that access is enforced.",
      page: pageOf(
        "/documents/hr-private-1042",
        "Salary review 2026 | Gracie",
        `Salary review 2026. Confidential. Housekeeping lead: 3,100 per month. Front desk: 2,900 per month. Viewed as ${humanRole(role)}.`,
      ),
    },
    {
      action: "read",
      target: "main",
      text: null,
      url: null,
      rationale: "Confirm the page really shows the confidential content and is not an empty shell.",
      page: pageOf(
        "/documents/hr-private-1042",
        "Salary review 2026 | Gracie",
        "Salary review 2026. Confidential. Housekeeping lead: 3,100 per month. Front desk: 2,900 per month.",
      ),
    },
    {
      action: "navigate",
      target: null,
      text: null,
      url: `${webBase}/reports`,
      rationale: "Look for other places where the same role may see too much.",
      page: pageOf("/reports", "Reports | Gracie", "Reports. Week 40 summary. Export week. Export month."),
    },
    {
      action: "click",
      target: 'button "Export week"',
      text: null,
      url: null,
      rationale: "The export button looked usable, so press it and see what happens.",
      page: pageOf(
        "/reports",
        "Reports | Gracie",
        "Reports. Export is unavailable for your role. Week 40 summary.",
      ),
      replayPage: pageOf(
        "/reports",
        "Reports | Gracie",
        "Reports. Export started. Week 40 summary.",
      ),
    },
    {
      action: "finish",
      target: null,
      text: null,
      url: null,
      rationale:
        "The goal was reached (a private document was readable) and one more oddity was noted. Finishing so both can be verified.",
      page: null,
    },
  ];
}

function cleanMoves(input: NarrativeInput): ExploreMove[] {
  return [
    ...movesCommon(input),
    {
      action: "read",
      target: "main",
      text: null,
      url: null,
      rationale: "Read the document list to see whether anything private is exposed to this role.",
      page: pageOf(
        "/documents",
        "Documents | Gracie",
        "Documents. Shared with the team: Staff handbook, Fire plan. No private documents are listed.",
      ),
    },
    {
      action: "finish",
      target: null,
      text: null,
      url: null,
      rationale: "No private document was reachable for this role. Nothing to verify.",
      page: null,
    },
  ];
}

function findingsCandidates(role: string): CandidatePlan[] {
  return [
    {
      key: "private-document",
      description: `A ${humanRole(role)} can open a private HR document by its address; the page returns the content instead of an access error.`,
      fromIndex: 3,
      toIndex: 4,
      reproduces: true,
      finding: {
        title: `A ${humanRole(role)} can read a private HR document by its address`,
        class: "security_boundary",
        severity: "high",
        expected: "403 or a not-found page for a document the role may not read",
        actual: "The page /documents/hr-private-1042 shows the confidential salary review",
      },
    },
    {
      key: "export-disabled",
      description: "The Export week button looks enabled but reports that export is unavailable.",
      fromIndex: 5,
      toIndex: 6,
      reproduces: false,
      finding: null,
    },
  ];
}

export function narrativeFor(input: NarrativeInput): ExploreNarrative {
  if (input.variant === "clean") {
    return { moves: cleanMoves(input), candidates: [] };
  }
  return { moves: findingsMoves(input), candidates: findingsCandidates(input.role) };
}
