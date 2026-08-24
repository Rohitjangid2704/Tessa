import { CircleAlert, CircleCheck } from "lucide-react";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { describeTier0Check } from "@/features/steps/format";
import type { Tier0Failure, Tier0Result } from "@/lib/api/types";
import { stringifyJson } from "./json-view";
import { StepSection } from "./step-section";
import { TruncatedText } from "./text-view";

const PASSED_MESSAGE = "All code checks passed.";
const NO_DETAILS_MESSAGE = "A check failed but no details were reported.";

function ValueCell({ value }: { value: unknown }) {
  if (value === null || value === undefined) {
    return <span className="text-muted-foreground">Not applicable</span>;
  }
  const text = typeof value === "string" ? value : stringifyJson(value);
  return <TruncatedText text={text} className="font-mono text-xs" />;
}

function FailureRow({ failure }: { failure: Tier0Failure }) {
  return (
    <TableRow data-check={failure.check}>
      <TableCell className="align-top font-medium whitespace-normal">
        {describeTier0Check(failure.check)}
      </TableCell>
      <TableCell className="wrap-anywhere align-top whitespace-normal">{failure.message}</TableCell>
      <TableCell className="align-top whitespace-normal">
        <ValueCell value={failure.expected} />
      </TableCell>
      <TableCell className="align-top whitespace-normal">
        <ValueCell value={failure.actual} />
      </TableCell>
    </TableRow>
  );
}

function Tier0Summary({ passed }: { passed: boolean }) {
  const Icon = passed ? CircleCheck : CircleAlert;
  return (
    <p data-slot="tier0-summary" className="flex items-center gap-2 text-sm">
      <Icon
        aria-hidden="true"
        className={passed ? "size-4 shrink-0 text-verdict-pass-fg" : "size-4 shrink-0"}
      />
      {passed ? PASSED_MESSAGE : NO_DETAILS_MESSAGE}
    </p>
  );
}

export function Tier0Failures({ tier0 }: { tier0: Tier0Result }) {
  const { failures, passed } = tier0;

  return (
    <StepSection title="Tier 0 checks">
      {failures.length === 0 ? (
        <Tier0Summary passed={passed} />
      ) : (
        <Table className="table-fixed">
          <TableCaption className="sr-only">
            {`${failures.length} code ${failures.length === 1 ? "check" : "checks"} failed`}
          </TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[22%]">Check</TableHead>
              <TableHead className="w-[38%] whitespace-normal">What was wrong</TableHead>
              <TableHead className="w-[20%]">Expected</TableHead>
              <TableHead className="w-[20%]">Actual</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {failures.map((failure, index) => (
              <FailureRow key={`${failure.check}:${index}`} failure={failure} />
            ))}
          </TableBody>
        </Table>
      )}
    </StepSection>
  );
}
