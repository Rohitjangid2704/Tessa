import { STAGE_ONE_IDS } from "../stage1/seed";
import { mockState } from "../state";
import type { BundleSource } from "@/lib/api/types";

export const BUNDLE_SOURCE_MODES = ["default", "unset"] as const;

export type BundleSourceMode = (typeof BUNDLE_SOURCE_MODES)[number];

export const PULL_FAILURES = ["none", "run", "request"] as const;

export type PullFailure = (typeof PULL_FAILURES)[number];

export const GIT_ALLOWED_HOSTS: readonly string[] = [
  "github.com",
  "gitlab.com",
  "git.tessa.dev",
];

export const DEFAULT_SOURCE_PATH = "tessa/";

const SEEDED_GRACIE_SOURCE: BundleSource = {
  git_url: "https://github.com/tessa/gracie.git",
  branch: "main",
  path: DEFAULT_SOURCE_PATH,
  credential_name: "GRACIE_ADMIN_TOKEN",
  last_pulled_at: "2026-10-03T09:15:00.000Z",
  last_ref: "7f3c9a2e5b1d4c60a8e91f2b3d7c4a5e6f708192",
};

export class BundleSourceStore {
  private sources = new Map<string, BundleSource>();
  private modeName: BundleSourceMode = "default";
  pullFailure: PullFailure = "none";

  constructor() {
    this.reset();
  }

  get mode(): BundleSourceMode {
    return this.modeName;
  }

  get configuredTargetIds(): string[] {
    return [...this.sources.keys()];
  }

  find(targetId: string): BundleSource | undefined {
    const source = this.sources.get(targetId);
    return source === undefined ? undefined : { ...source };
  }

  save(targetId: string, source: BundleSource): BundleSource {
    this.sources.set(targetId, { ...source });
    return { ...source };
  }

  recordPull(targetId: string, pulledAt: string, ref: string): void {
    const source = this.sources.get(targetId);
    if (source !== undefined) {
      this.sources.set(targetId, { ...source, last_pulled_at: pulledAt, last_ref: ref });
    }
  }

  setMode(mode: BundleSourceMode): void {
    this.modeName = mode;
    this.sources = new Map();
    if (mode === "default") {
      this.sources.set(STAGE_ONE_IDS.gracie, { ...SEEDED_GRACIE_SOURCE });
    }
  }

  reset(): void {
    this.pullFailure = "none";
    this.setMode("default");
  }
}

export const bundleSources = new BundleSourceStore();

mockState.stageTwo.onReset(() => bundleSources.reset());
