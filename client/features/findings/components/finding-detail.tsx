"use client";

import { useQuery } from "@tanstack/react-query";
import { Bot, ExternalLink } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useId } from "react";
import { DateTime } from "@/components/date-time";
import { FindingStatusBadge } from "@/components/status/finding-status-badge";
import { SeverityBadge } from "@/components/status/severity-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { Finding } from "@/lib/api/types";
import { useCanDo } from "@/lib/auth/can";
import { findingRoutes } from "@/lib/routes";
import { cn } from "@/lib/utils";
import { findingDetailQuery, isFindingForbidden, isFindingNotFound } from "../detail-queries";
import { describeSystemMove, parseStructuredExplanation } from "../detail-schemas";
import {
  DETAIL_TAB_LABELS,
  DETAIL_TAB_PARAM,
  DETAIL_TABS,
  parseDetailTab,
  writeDetailTab,
} from "../detail-url";
import { clearSystemMove, useSystemMove } from "../system-moves";
import { useFindingLive } from "../use-finding-live";
import { ExplainPromptDialog } from "./explain-prompt-dialog";
import { ExplanationForm } from "./explanation-form";
import { ExplanationList } from "./explanation-list";
import { ExplanationOpinionBadge } from "./explanation-opinion-badge";
import { FindingClassChip } from "./finding-class-chip";
import {
  BackToFindings,
  FindingDetailSkeleton,
  FindingForbidden,
  FindingLoadError,
  FindingNotFound,
  type FindingDetailVariant,
} from "./finding-detail-states";
import { FindingOverview } from "./finding-overview";
import { OccurrenceList } from "./occurrence-list";
import { PromoteDialog } from "./promote-dialog";
import { ReproPanel } from "./repro-panel";

export type { FindingDetailVariant } from "./finding-detail-states";

export interface FindingDetailProps {
  findingId: string;
  variant: FindingDetailVariant;
}

function SystemMoveNote({ findingId }: { findingId: string }) {
  const notice = useSystemMove(findingId);
  return (
    <div role="status" aria-live="polite" data-slot="system-move-slot">
      {notice === null ? null : (
        <div
          data-slot="system-move-note"
          className="flex items-start gap-2 rounded-lg border bg-muted/50 px-3 py-2 text-sm"
        >
          <Bot aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <p className="min-w-0 flex-1">
            {describeSystemMove(notice)}{" "}
            <DateTime value={notice.at} className="text-muted-foreground" />
          </p>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => clearSystemMove(findingId)}
          >
            Dismiss
          </Button>
        </div>
      )}
    </div>
  );
}

interface FindingDetailContentProps {
  finding: Finding;
  variant: FindingDetailVariant;
}

function FindingDetailContent({ finding, variant }: FindingDetailContentProps) {
  const headingId = useId();
  const updateAccess = useCanDo("findings.update");
  const searchParams = useSearchParams();
  const tab = parseDetailTab(searchParams?.get(DETAIL_TAB_PARAM));
  const Heading = variant === "page" ? "h1" : "h2";
  const latestOpinion =
    parseStructuredExplanation(finding.latest_explanation?.structured)?.opinion ?? null;

  useFindingLive({ targetId: finding.target_id, enabled: variant === "page" });

  return (
    <section
      aria-labelledby={headingId}
      data-slot="finding-detail"
      data-variant={variant}
      className="flex min-w-0 flex-col gap-4"
    >
      <header className={cn("flex flex-col gap-3", variant === "sheet" && "pr-10")}>
        {variant === "page" ? <BackToFindings targetId={finding.target_id} /> : null}
        <Heading id={headingId} className="text-lg leading-snug font-semibold wrap-anywhere">
          {finding.title}
        </Heading>
        <div className="flex flex-wrap items-center gap-2">
          <FindingStatusBadge status={finding.status} />
          <SeverityBadge severity={finding.severity} />
          <FindingClassChip findingClass={finding.class} />
          {finding.invariant_id === null ? null : (
            <Badge variant="outline" className="font-mono">
              {finding.invariant_id}
            </Badge>
          )}
          {latestOpinion === null ? null : <ExplanationOpinionBadge opinion={latestOpinion} />}
          <Badge variant="secondary">
            {finding.occurrence_count}{" "}
            {finding.occurrence_count === 1 ? "occurrence" : "occurrences"}
          </Badge>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ExplainPromptDialog finding={finding} />
          <PromoteDialog finding={finding} />
          {variant === "sheet" ? (
            <Button asChild variant="ghost" size="sm">
              <Link href={findingRoutes.detail(finding.id)}>
                <ExternalLink aria-hidden="true" data-icon="inline-start" />
                Open full page
              </Link>
            </Button>
          ) : null}
        </div>
        {updateAccess.reason === null ? null : (
          <p className="text-xs text-muted-foreground">
            You can read this finding. Changing it needs the member or admin role.
          </p>
        )}
      </header>
      <SystemMoveNote findingId={finding.id} />
      <Tabs value={tab} onValueChange={(value) => writeDetailTab(parseDetailTab(value))}>
        <div className="max-w-full overflow-x-auto">
          <TabsList aria-label="Finding sections">
            {DETAIL_TABS.map((name) => (
              <TabsTrigger key={name} value={name} className="px-3">
                {name === "occurrences"
                  ? `${DETAIL_TAB_LABELS[name]} (${finding.occurrence_count})`
                  : DETAIL_TAB_LABELS[name]}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        <TabsContent value="overview" className="pt-2">
          <FindingOverview
            finding={finding}
            onOpenExplanations={() => writeDetailTab("explanations")}
          />
        </TabsContent>
        <TabsContent value="repro" className="pt-2">
          <ReproPanel findingId={finding.id} />
        </TabsContent>
        <TabsContent value="occurrences" className="pt-2">
          <OccurrenceList findingId={finding.id} />
        </TabsContent>
        <TabsContent value="explanations" className="flex flex-col gap-6 pt-2">
          <ExplanationForm findingId={finding.id} />
          <ExplanationList finding={finding} />
        </TabsContent>
      </Tabs>
    </section>
  );
}

export function FindingDetail({ findingId, variant }: FindingDetailProps) {
  const query = useQuery(findingDetailQuery(findingId));
  const finding = query.data;

  if (finding !== undefined) {
    return <FindingDetailContent key={finding.id} finding={finding} variant={variant} />;
  }
  if (query.isError) {
    if (isFindingNotFound(query.error)) {
      return <FindingNotFound variant={variant} error={query.error} />;
    }
    if (isFindingForbidden(query.error)) {
      return <FindingForbidden variant={variant} error={query.error} />;
    }
    return (
      <FindingLoadError
        variant={variant}
        error={query.error}
        onRetry={() => void query.refetch()}
      />
    );
  }
  return <FindingDetailSkeleton />;
}
