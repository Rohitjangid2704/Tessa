export const toneClasses = {
  "verdict-pass": "border-verdict-pass-fg/25 bg-verdict-pass-bg text-verdict-pass-fg",
  "verdict-fail": "border-verdict-fail-fg/25 bg-verdict-fail-bg text-verdict-fail-fg",
  "verdict-flaky": "border-verdict-flaky-fg/25 bg-verdict-flaky-bg text-verdict-flaky-fg",
  "verdict-uncertain":
    "border-verdict-uncertain-fg/25 bg-verdict-uncertain-bg text-verdict-uncertain-fg",
  "verdict-skipped": "border-verdict-skipped-fg/25 bg-verdict-skipped-bg text-verdict-skipped-fg",
  "severity-critical":
    "border-severity-critical-fg/25 bg-severity-critical-bg text-severity-critical-fg",
  "severity-critical-solid":
    "border-transparent bg-severity-critical-solid text-severity-critical-solid-fg",
  "severity-high": "border-severity-high-fg/25 bg-severity-high-bg text-severity-high-fg",
  "severity-medium": "border-severity-medium-fg/25 bg-severity-medium-bg text-severity-medium-fg",
  "severity-low": "border-severity-low-fg/25 bg-severity-low-bg text-severity-low-fg",
  "severity-info": "border-severity-info-fg/25 bg-severity-info-bg text-severity-info-fg",
  "tier-code": "border-tier-code-fg/25 bg-tier-code-bg text-tier-code-fg",
  "tier-laya": "border-tier-laya-fg/25 bg-tier-laya-bg text-tier-laya-fg",
  "tier-judge": "border-tier-judge-fg/25 bg-tier-judge-bg text-tier-judge-fg",
  "tier-human": "border-tier-human-fg/25 bg-tier-human-bg text-tier-human-fg",
  "tier-production": "border-transparent bg-tier-production-solid text-tier-production-solid-fg",
  "live-live": "border-live-live-fg/25 bg-live-live-bg text-live-live-fg",
  "live-reconnecting":
    "border-live-reconnecting-fg/25 bg-live-reconnecting-bg text-live-reconnecting-fg",
  "live-closed": "border-live-closed-fg/25 bg-live-closed-bg text-live-closed-fg",
  "live-error": "border-live-error-fg/25 bg-live-error-bg text-live-error-fg",
  "finding-new": "border-finding-new-fg/25 bg-finding-new-bg text-finding-new-fg",
  "finding-triaged": "border-finding-triaged-fg/25 bg-finding-triaged-bg text-finding-triaged-fg",
  "finding-in-fix": "border-finding-in-fix-fg/25 bg-finding-in-fix-bg text-finding-in-fix-fg",
  "finding-verifying":
    "border-finding-verifying-fg/25 bg-finding-verifying-bg text-finding-verifying-fg",
  "finding-resolved":
    "border-finding-resolved-fg/25 bg-finding-resolved-bg text-finding-resolved-fg",
  "finding-known-gap":
    "border-finding-known-gap-fg/25 bg-finding-known-gap-bg text-finding-known-gap-fg",
  "finding-dismissed":
    "border-finding-dismissed-fg/25 bg-finding-dismissed-bg text-finding-dismissed-fg",
  "kpi-good": "border-kpi-good-fg/25 bg-kpi-good-bg text-kpi-good-fg",
  "kpi-warn": "border-kpi-warn-fg/25 bg-kpi-warn-bg text-kpi-warn-fg",
  "kpi-bad": "border-kpi-bad-fg/25 bg-kpi-bad-bg text-kpi-bad-fg",
  "attack-blocked":
    "border-attack-blocked-fg/25 bg-attack-blocked-bg text-attack-blocked-fg",
  "attack-breached":
    "border-attack-breached-fg/25 bg-attack-breached-bg text-attack-breached-fg",
  "attack-inconclusive":
    "border-attack-inconclusive-fg/25 bg-attack-inconclusive-bg text-attack-inconclusive-fg",
  proposed: "border-proposed-fg/25 bg-proposed-bg text-proposed-fg",
  hollow: "border-dashed border-muted-foreground/50 bg-transparent text-muted-foreground",
} as const;

export type Tone = keyof typeof toneClasses;
