import { Terminal } from "lucide-react";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { HealthTick } from "@/components/status/health-tick";
import { LiveIndicator } from "@/components/status/live-indicator";
import { RunStatusBadge } from "@/components/status/run-status-badge";
import { SeverityBadge } from "@/components/status/severity-badge";
import {
  HEALTH_STATUSES,
  LIVE_STATES,
  RUN_STATUSES,
  SEVERITIES,
  VERDICT_STATUSES,
  VERDICT_TIERS,
} from "@/components/status/status-types";
import { TierBadge } from "@/components/status/tier-badge";
import { VerdictBadge } from "@/components/status/verdict-badge";
import { ThemeToggle } from "@/components/theme-toggle";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { assertDevelopmentOnly } from "@/lib/dev-only";

export function generateMetadata(): Metadata {
  assertDevelopmentOnly();
  return { title: "Design tokens" };
}

const coreSwatches = [
  { token: "background", className: "bg-background text-foreground" },
  { token: "card", className: "bg-card text-card-foreground" },
  { token: "popover", className: "bg-popover text-popover-foreground" },
  { token: "primary", className: "bg-primary text-primary-foreground" },
  { token: "secondary", className: "bg-secondary text-secondary-foreground" },
  { token: "muted", className: "bg-muted text-muted-foreground" },
  { token: "accent", className: "bg-accent text-accent-foreground" },
  { token: "sidebar", className: "bg-sidebar text-sidebar-foreground" },
  { token: "sidebar-primary", className: "bg-sidebar-primary text-sidebar-primary-foreground" },
  { token: "sidebar-accent", className: "bg-sidebar-accent text-sidebar-accent-foreground" },
  {
    token: "severity-critical-solid",
    className: "bg-severity-critical-solid text-severity-critical-solid-fg",
  },
] as const;

const semanticSwatches = [
  { token: "verdict-pass", className: "bg-verdict-pass-bg text-verdict-pass-fg" },
  { token: "verdict-fail", className: "bg-verdict-fail-bg text-verdict-fail-fg" },
  { token: "verdict-flaky", className: "bg-verdict-flaky-bg text-verdict-flaky-fg" },
  { token: "verdict-uncertain", className: "bg-verdict-uncertain-bg text-verdict-uncertain-fg" },
  { token: "verdict-skipped", className: "bg-verdict-skipped-bg text-verdict-skipped-fg" },
  { token: "severity-critical", className: "bg-severity-critical-bg text-severity-critical-fg" },
  { token: "severity-high", className: "bg-severity-high-bg text-severity-high-fg" },
  { token: "severity-medium", className: "bg-severity-medium-bg text-severity-medium-fg" },
  { token: "severity-low", className: "bg-severity-low-bg text-severity-low-fg" },
  { token: "severity-info", className: "bg-severity-info-bg text-severity-info-fg" },
  { token: "tier-code", className: "bg-tier-code-bg text-tier-code-fg" },
  { token: "tier-laya", className: "bg-tier-laya-bg text-tier-laya-fg" },
  { token: "tier-judge", className: "bg-tier-judge-bg text-tier-judge-fg" },
  { token: "tier-human", className: "bg-tier-human-bg text-tier-human-fg" },
  { token: "live-live", className: "bg-live-live-bg text-live-live-fg" },
  { token: "live-reconnecting", className: "bg-live-reconnecting-bg text-live-reconnecting-fg" },
  { token: "live-closed", className: "bg-live-closed-bg text-live-closed-fg" },
  { token: "live-error", className: "bg-live-error-bg text-live-error-fg" },
] as const;

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="text-lg font-semibold">{title}</h2>
        {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {children}
    </section>
  );
}

function SwatchGrid({ swatches }: { swatches: readonly { token: string; className: string }[] }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {swatches.map(({ token, className }) => (
        <div key={token} className={`flex flex-col gap-1 rounded-lg border p-3 ${className}`}>
          <span className="text-lg font-semibold">Aa</span>
          <span className="font-mono text-xs">{token}</span>
        </div>
      ))}
    </div>
  );
}

function BadgeRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="w-28 shrink-0 text-sm text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

export default function TokenGalleryPage() {
  assertDevelopmentOnly();

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-10 p-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Design tokens</h1>
          <p className="text-sm text-muted-foreground">
            Every foreground and background pair here is checked at 4.5:1 or better in light and
            dark by <code className="font-mono">lib/tokens/contrast.test.ts</code>.
          </p>
        </div>
        <ThemeToggle />
      </header>

      <Section title="Core tokens" description="shadcn tokens from app/globals.css.">
        <SwatchGrid swatches={coreSwatches} />
      </Section>

      <Section
        title="Semantic tokens"
        description="--{family}-{name}-bg and -fg, used as bg-verdict-pass-bg and text-verdict-pass-fg."
      >
        <SwatchGrid swatches={semanticSwatches} />
      </Section>

      <Section title="Status components" description="Icon plus label on every badge.">
        <div className="flex flex-col gap-3">
          <BadgeRow label="Verdict">
            {VERDICT_STATUSES.map((verdict) => (
              <VerdictBadge key={verdict} verdict={verdict} />
            ))}
          </BadgeRow>
          <BadgeRow label="Severity">
            {SEVERITIES.map((severity) => (
              <SeverityBadge key={severity} severity={severity} />
            ))}
          </BadgeRow>
          <BadgeRow label="Tier">
            {VERDICT_TIERS.map((tier) => (
              <TierBadge key={tier} tier={tier} />
            ))}
          </BadgeRow>
          <BadgeRow label="Run status">
            {RUN_STATUSES.map((status) => (
              <RunStatusBadge key={status} status={status} />
            ))}
          </BadgeRow>
          <BadgeRow label="Health">
            {HEALTH_STATUSES.map((status) => (
              <HealthTick key={status} status={status} />
            ))}
          </BadgeRow>
          <BadgeRow label="Live">
            {LIVE_STATES.map((state) => (
              <LiveIndicator key={state} state={state} />
            ))}
          </BadgeRow>
        </div>
      </Section>

      <Section title="Primitives" description="shadcn components under components/ui.">
        <div className="flex flex-wrap items-center gap-2">
          <Button>Default</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="outline">Outline</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="destructive">Destructive</Button>
          <Button variant="link">Link</Button>
          <Button disabled>Disabled</Button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge>Default</Badge>
          <Badge variant="secondary">Secondary</Badge>
          <Badge variant="outline">Outline</Badge>
          <Badge variant="destructive">Destructive</Badge>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Card</CardTitle>
              <CardDescription>Card description in muted foreground.</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              <Label htmlFor="token-input">Label</Label>
              <Input id="token-input" placeholder="Input placeholder" />
            </CardContent>
          </Card>
          <div className="flex flex-col gap-3">
            <Alert>
              <Terminal aria-hidden="true" />
              <AlertTitle>Alert</AlertTitle>
              <AlertDescription>Default alert description.</AlertDescription>
            </Alert>
            <Alert variant="destructive">
              <Terminal aria-hidden="true" />
              <AlertTitle>Destructive alert</AlertTitle>
              <AlertDescription>Destructive alert description.</AlertDescription>
            </Alert>
            <Skeleton className="h-8 w-full" />
          </div>
        </div>
      </Section>
    </div>
  );
}
