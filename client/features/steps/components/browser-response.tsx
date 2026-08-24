import { CircleCheck, CircleMinus, CircleX, ExternalLink, type LucideIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type {
  BrowserConsoleEntry,
  BrowserStepResponse,
  DomStateObservation,
} from "@/lib/api/types";
import { safeHttpUrl } from "@/lib/safe-http-url";
import { EmptyNote, FactList, Subsection, type Fact } from "./step-section";
import { TextView, TruncatedText } from "./text-view";

type CheckState = "good" | "bad" | "neutral";

const CHECK_ICONS: Record<CheckState, LucideIcon> = {
  good: CircleCheck,
  bad: CircleX,
  neutral: CircleMinus,
};

function PageLink({ url }: { url: string }) {
  const href = safeHttpUrl(url);
  if (href === null) {
    return <>{url}</>;
  }
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 underline underline-offset-4"
    >
      {url}
      <ExternalLink aria-hidden="true" className="size-3 shrink-0" />
      <span className="sr-only">(opens in a new tab)</span>
    </a>
  );
}

function ConsoleBlock({ entries }: { entries: readonly BrowserConsoleEntry[] }) {
  return (
    <Subsection title="Console">
      {entries.length === 0 ? (
        <EmptyNote compact>No console messages were captured.</EmptyNote>
      ) : (
        <ul data-slot="console-entries" className="divide-y rounded-md border text-xs">
          {entries.map((entry, index) => (
            <li key={index} className="flex flex-col gap-1 px-3 py-1.5 sm:flex-row sm:gap-3">
              <Badge
                variant={entry.level === "error" ? "destructive" : "outline"}
                className="shrink-0 self-start"
              >
                {entry.level}
              </Badge>
              <TruncatedText text={entry.text} className="font-mono" />
            </li>
          ))}
        </ul>
      )}
    </Subsection>
  );
}

interface CheckRowProps {
  subject: string;
  state: CheckState;
  label: string;
}

function CheckRow({ subject, state, label }: CheckRowProps) {
  const Icon = CHECK_ICONS[state];
  return (
    <li className="flex items-start gap-2 px-3 py-1.5">
      <Icon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 font-mono wrap-anywhere">{subject}</span>
      <span className="shrink-0 font-medium">{label}</span>
    </li>
  );
}

function elementState(status: string): CheckState {
  if (status === "visible") {
    return "good";
  }
  return status === "missing" ? "bad" : "neutral";
}

function describeElementStatus(status: string): string {
  return `${status.charAt(0).toUpperCase()}${status.slice(1)}`;
}

function DomStateBlock({ state }: { state: DomStateObservation | null }) {
  const texts = state === null ? [] : Object.entries(state.text_found);
  const elements = state === null ? [] : Object.entries(state.elements);
  return (
    <Subsection title="Page state checks">
      {texts.length === 0 && elements.length === 0 ? (
        <EmptyNote compact>No page state checks were recorded.</EmptyNote>
      ) : (
        <ul data-slot="dom-state" className="divide-y rounded-md border text-xs">
          {texts.map(([text, found]) => (
            <CheckRow
              key={`text:${text}`}
              subject={`Text: ${text}`}
              state={found ? "good" : "bad"}
              label={found ? "Shown" : "Not shown"}
            />
          ))}
          {elements.map(([key, status]) => (
            <CheckRow
              key={`element:${key}`}
              subject={`Element: ${key}`}
              state={elementState(status)}
              label={describeElementStatus(status)}
            />
          ))}
        </ul>
      )}
    </Subsection>
  );
}

export function BrowserResponseDetails({ response }: { response: BrowserStepResponse }) {
  const facts: Fact[] = [{ label: "Page", value: <PageLink url={response.url} />, mono: true }];
  if (response.title !== null) {
    facts.push({ label: "Title", value: response.title });
  }
  return (
    <div data-slot="browser-response" className="flex flex-col gap-4">
      <FactList facts={facts} />
      {response.text_excerpt !== null ? (
        <TextView label="Text excerpt" text={response.text_excerpt} />
      ) : null}
      <ConsoleBlock entries={response.console} />
      <DomStateBlock state={response.dom_state} />
    </div>
  );
}
