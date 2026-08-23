"use client";

import { ChevronDown } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { AdapterChip } from "@/features/adapters/components/adapter-chip";
import { RiskBadge } from "@/features/proposals/components/proposal-badges";
import { ALL_ROLES_ID, NO_CLEANUP, NO_FLAG } from "../schemas";
import type { AdapterKind, CatalogExample, CatalogItem } from "../types";
import { ChipList } from "./chip-list";
import { ConfidenceChip } from "./confidence-chip";
import { KindBadge } from "./kind-badge";

export interface FeatureCardProps {
  item: CatalogItem;
  selected?: boolean;
  onSelectedChange?: (selected: boolean) => void;
  defaultOpen?: boolean;
  interfaceKinds?: ReadonlyMap<string, AdapterKind>;
}

function formatRole(role: string): string {
  return role === ALL_ROLES_ID ? "All roles" : role;
}

function renderInterface(interfaceId: string, kinds: ReadonlyMap<string, AdapterKind>): ReactNode {
  const kind = kinds.get(interfaceId);
  if (kind === undefined) {
    return (
      <Badge variant="outline" className="font-mono">
        {interfaceId}
      </Badge>
    );
  }
  return <AdapterChip kind={kind} label={interfaceId} mono />;
}

function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function hasWriteDetails(item: CatalogItem): boolean {
  return (
    (item.writes_to ?? null) !== null ||
    (item.confirmation ?? null) !== null ||
    (item.expect_db ?? null) !== null
  );
}

function DetailSection({ title, children }: { title: string; children: ReactNode }) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-1.5">
      <h4
        id={headingId}
        className="text-xs font-semibold tracking-wide text-muted-foreground uppercase"
      >
        {title}
      </h4>
      {children}
    </section>
  );
}

function PlainList({ items, emptyLabel }: { items: readonly string[]; emptyLabel: string }) {
  if (items.length === 0) {
    return <p className="text-muted-foreground">{emptyLabel}</p>;
  }
  return (
    <ul className="flex list-disc flex-col gap-1 pl-5">
      {items.map((entry) => (
        <li key={entry}>{entry}</li>
      ))}
    </ul>
  );
}

function CodeBlock({ value }: { value: unknown }) {
  return (
    <pre className="rounded-md bg-muted p-2 font-mono text-xs break-all whitespace-pre-wrap">
      {formatJson(value)}
    </pre>
  );
}

function ExampleItem({ example }: { example: CatalogExample }) {
  const hasRequest = example.request !== undefined && example.request !== null;
  return (
    <li className="rounded-lg border p-3">
      <dl className="grid grid-cols-[5.5rem_1fr] gap-x-3 gap-y-1.5">
        {example.ask ? (
          <>
            <dt className="text-muted-foreground">Ask</dt>
            <dd>{example.ask}</dd>
          </>
        ) : null}
        {hasRequest ? (
          <>
            <dt className="text-muted-foreground">Request</dt>
            <dd className="min-w-0">
              <CodeBlock value={example.request} />
            </dd>
          </>
        ) : null}
        <dt className="text-muted-foreground">Expected</dt>
        <dd>{example.expected}</dd>
        {example.oracle ? (
          <>
            <dt className="text-muted-foreground">Oracle</dt>
            <dd className="font-mono text-xs break-all">{example.oracle}</dd>
          </>
        ) : null}
      </dl>
    </li>
  );
}

function WriteDetails({ item }: { item: CatalogItem }) {
  return (
    <DetailSection title="Write details">
      <dl className="grid grid-cols-[7.5rem_1fr] gap-x-3 gap-y-1.5">
        {item.writes_to ? (
          <>
            <dt className="text-muted-foreground">Writes to</dt>
            <dd className="font-mono text-xs break-all">{item.writes_to}</dd>
          </>
        ) : null}
        {item.confirmation ? (
          <>
            <dt className="text-muted-foreground">Confirmation</dt>
            <dd>{item.confirmation}</dd>
          </>
        ) : null}
        {item.expect_db ? (
          <>
            <dt className="text-muted-foreground">Expected database state</dt>
            <dd className="min-w-0">
              <CodeBlock value={item.expect_db} />
            </dd>
          </>
        ) : null}
      </dl>
    </DetailSection>
  );
}

function FeatureDetails({ item }: { item: CatalogItem }) {
  return (
    <div className="flex flex-col gap-4 border-t pt-4 text-sm">
      <DetailSection title="Preconditions">
        <PlainList items={item.preconditions} emptyLabel="None" />
      </DetailSection>
      <DetailSection title={`Examples (${item.examples.length})`}>
        {item.examples.length === 0 ? (
          <p className="text-muted-foreground">No examples in this bundle.</p>
        ) : (
          <ol className="flex flex-col gap-2">
            {item.examples.map((example, index) => (
              <ExampleItem key={index} example={example} />
            ))}
          </ol>
        )}
      </DetailSection>
      <DetailSection title="Invariants">
        {item.invariants.length === 0 ? (
          <p className="text-muted-foreground">None</p>
        ) : (
          <ChipList label="Invariants" items={item.invariants} showLabel={false} />
        )}
      </DetailSection>
      <DetailSection title="Cleanup">
        {item.cleanup === NO_CLEANUP ? (
          <p className="text-muted-foreground">None</p>
        ) : (
          <p>{item.cleanup}</p>
        )}
      </DetailSection>
      {hasWriteDetails(item) ? <WriteDetails item={item} /> : null}
    </div>
  );
}

export function FeatureCard({
  item,
  selected = false,
  onSelectedChange,
  defaultOpen = false,
  interfaceKinds,
}: FeatureCardProps) {
  const headingId = useId();
  const [open, setOpen] = useState(defaultOpen);
  const exampleCount = item.examples.length;
  const proposalRisk = item.proposal_risk ?? null;

  return (
    <article
      data-slot="feature-card"
      data-item-id={item.id}
      data-kind={item.kind}
      aria-labelledby={headingId}
      className="flex gap-3 rounded-xl border bg-card p-4 text-card-foreground"
    >
      {onSelectedChange === undefined ? null : (
        <Checkbox
          aria-label={`Select ${item.feature_id}`}
          checked={selected}
          onCheckedChange={(checked) => onSelectedChange(checked === true)}
          className="mt-1"
        />
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
          <h3 id={headingId} className="font-mono text-sm font-semibold break-all">
            {item.feature_id}
          </h3>
          <div className="flex flex-wrap items-center gap-1.5">
            <KindBadge kind={item.kind} />
            <ConfidenceChip confidence={item.confidence} />
            {proposalRisk === null ? null : (
              <RiskBadge
                risk={proposalRisk}
                data-slot="proposal-risk-chip"
                title="Risk from the test proposal"
              />
            )}
          </div>
        </div>
        <p className="text-sm">{item.description}</p>
        <div className="flex flex-col gap-1.5">
          <ChipList
            label="Interfaces"
            items={item.interface_ids}
            renderItem={
              interfaceKinds === undefined
                ? undefined
                : (interfaceId) => renderInterface(interfaceId, interfaceKinds)
            }
            emptyLabel="none"
          />
          <ChipList label="Roles" items={item.roles} formatItem={formatRole} emptyLabel="none" />
          <ChipList label="Flag" items={item.flag === NO_FLAG ? [] : [item.flag]} />
        </div>
        <Collapsible open={open} onOpenChange={setOpen} className="flex flex-col gap-3">
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="sm" className="-ml-2 self-start">
              <ChevronDown
                aria-hidden="true"
                className={open ? "rotate-180 transition-transform" : "transition-transform"}
              />
              Details <span className="sr-only">of {item.feature_id}</span>{" "}
              <span className="font-normal text-muted-foreground">
                {exampleCount === 1 ? "1 example" : `${exampleCount} examples`}
              </span>
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <FeatureDetails item={item} />
          </CollapsibleContent>
        </Collapsible>
      </div>
    </article>
  );
}
