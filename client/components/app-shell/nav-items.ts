import {
  Bug,
  Compass,
  DatabaseZap,
  FlaskConical,
  GitCompareArrows,
  Grid3x3,
  History,
  Library,
  LibraryBig,
  ListChecks,
  Play,
  Settings,
  ShieldAlert,
  Sprout,
  Tags,
  Target,
  UsersRound,
  type LucideIcon,
} from "lucide-react";
import type { PermissionId } from "@/lib/auth/permissions";
import { routes, withQuery } from "@/lib/routes";

export type NavGroupId = "workspace" | "explore" | "truth" | "system";

export type NavItem = {
  id: string;
  label: string;
  href: string;
  icon: LucideIcon;
  carriesTarget: boolean;
  group: NavGroupId;
  action?: PermissionId;
};

export type NavGroup = {
  id: NavGroupId;
  label: string | null;
  items: readonly NavItem[];
};

export const NAV_ITEMS: readonly NavItem[] = [
  {
    id: "targets",
    label: "Targets",
    href: routes.targets,
    icon: Target,
    carriesTarget: false,
    group: "workspace",
  },
  {
    id: "catalog",
    label: "Catalog",
    href: routes.catalog,
    icon: LibraryBig,
    carriesTarget: true,
    group: "workspace",
  },
  {
    id: "coverage",
    label: "Coverage",
    href: routes.coverage,
    icon: Grid3x3,
    carriesTarget: true,
    group: "workspace",
  },
  {
    id: "scenarios",
    label: "Scenarios",
    href: routes.scenarios,
    icon: ListChecks,
    carriesTarget: true,
    group: "workspace",
  },
  {
    id: "runs",
    label: "Runs",
    href: routes.runs,
    icon: Play,
    carriesTarget: true,
    group: "workspace",
  },
  {
    id: "findings",
    label: "Findings",
    href: routes.findings,
    icon: Bug,
    carriesTarget: true,
    group: "workspace",
  },
  {
    id: "labels",
    label: "Labels",
    href: routes.labels,
    icon: Tags,
    carriesTarget: true,
    group: "workspace",
  },
  {
    id: "mutation",
    label: "Mutation",
    href: routes.mutation,
    icon: FlaskConical,
    carriesTarget: true,
    group: "workspace",
  },
  {
    id: "contracts",
    label: "Contracts",
    href: routes.contracts,
    icon: GitCompareArrows,
    carriesTarget: false,
    group: "workspace",
  },
  {
    id: "library",
    label: "Library",
    href: routes.library,
    icon: Library,
    carriesTarget: false,
    group: "workspace",
  },
  {
    id: "explore",
    label: "Explore",
    href: routes.explore,
    icon: Compass,
    carriesTarget: true,
    group: "explore",
  },
  {
    id: "simulators",
    label: "Simulators",
    href: routes.simulators,
    icon: UsersRound,
    carriesTarget: true,
    group: "explore",
  },
  {
    id: "redteam",
    label: "Red team",
    href: routes.redteam,
    icon: ShieldAlert,
    carriesTarget: true,
    group: "explore",
  },
  {
    id: "replay",
    label: "Replay",
    href: routes.replay,
    icon: History,
    carriesTarget: true,
    group: "explore",
  },
  {
    id: "seeds",
    label: "Seeds",
    href: routes.seeds,
    icon: Sprout,
    carriesTarget: true,
    group: "truth",
  },
  {
    id: "oracle",
    label: "Oracle",
    href: routes.oracle,
    icon: DatabaseZap,
    carriesTarget: true,
    group: "truth",
  },
  {
    id: "settings",
    label: "Settings",
    href: routes.settings,
    icon: Settings,
    carriesTarget: false,
    group: "system",
  },
];

const GROUP_LABELS: Record<NavGroupId, string | null> = {
  workspace: null,
  explore: "Explore",
  truth: "Truth",
  system: null,
};

export const NAV_GROUPS: readonly NavGroup[] = (Object.keys(GROUP_LABELS) as NavGroupId[]).map(
  (id) => ({
    id,
    label: GROUP_LABELS[id],
    items: NAV_ITEMS.filter((item) => item.group === id),
  }),
);

export function isNavItemVisible(
  item: Pick<NavItem, "action">,
  canDoAction: (action: PermissionId) => boolean,
): boolean {
  return item.action === undefined || canDoAction(item.action);
}

export function visibleNavGroups(
  groups: readonly NavGroup[],
  canDoAction: (action: PermissionId) => boolean,
): readonly NavGroup[] {
  return groups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => isNavItemVisible(item, canDoAction)),
    }))
    .filter((group) => group.items.length > 0);
}

export function navHref(item: Pick<NavItem, "href" | "carriesTarget">, targetId?: string | null) {
  return withQuery(item.href, item.carriesTarget ? { target_id: targetId } : {});
}

export function isNavItemActive(href: string, pathname: string): boolean {
  if (href === routes.home) {
    return pathname === routes.home;
  }
  return pathname === href || pathname.startsWith(`${href}/`);
}
