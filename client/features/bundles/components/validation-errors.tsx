import { CircleCheck, TriangleAlert, X } from "lucide-react";
import { useId } from "react";
import { StatusBadge } from "@/components/status/status-badge";
import type { components } from "@/lib/api/schema";
import { pluralize } from "../format";

type BundleValidationError = components["schemas"]["BundleValidationError"];

export interface FileProblemGroup {
  file: string;
  errors: BundleValidationError[];
  warnings: BundleValidationError[];
}

export function groupProblemsByFile(
  errors: readonly BundleValidationError[],
  warnings: readonly BundleValidationError[],
): FileProblemGroup[] {
  const groups = new Map<string, FileProblemGroup>();
  const groupFor = (file: string): FileProblemGroup => {
    const existing = groups.get(file);
    if (existing !== undefined) {
      return existing;
    }
    const created: FileProblemGroup = { file, errors: [], warnings: [] };
    groups.set(file, created);
    return created;
  };
  for (const error of errors) {
    groupFor(error.file).errors.push(error);
  }
  for (const warning of warnings) {
    groupFor(warning.file).warnings.push(warning);
  }
  return [...groups.values()].sort((left, right) => {
    const leftHasErrors = left.errors.length > 0 ? 0 : 1;
    const rightHasErrors = right.errors.length > 0 ? 0 : 1;
    return leftHasErrors - rightHasErrors;
  });
}

export function describeLocation(problem: BundleValidationError): string | null {
  const parts: string[] = [];
  if (problem.line !== null && problem.line !== undefined) {
    parts.push(`line ${problem.line}`);
    if (problem.column !== null && problem.column !== undefined) {
      parts.push(`column ${problem.column}`);
    }
  }
  return parts.length === 0 ? null : parts.join(", ");
}

function SeverityTag({ severity }: { severity: BundleValidationError["severity"] }) {
  return severity === "error" ? (
    <StatusBadge tone="verdict-fail" label="Error" icon={X} />
  ) : (
    <StatusBadge tone="verdict-flaky" label="Warning" icon={TriangleAlert} />
  );
}

function ProblemItem({ problem }: { problem: BundleValidationError }) {
  const location = describeLocation(problem);
  return (
    <li
      data-severity={problem.severity}
      data-code={problem.code}
      className="flex flex-col gap-1.5 rounded-lg border p-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <SeverityTag severity={problem.severity} />
        <code className="font-mono text-xs">{problem.code}</code>
      </div>
      <p className="text-sm">{problem.message}</p>
      {problem.pointer || location ? (
        <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {problem.pointer ? (
            <span>
              Pointer <code className="font-mono">{problem.pointer}</code>
            </span>
          ) : null}
          {location ? <span>{location}</span> : null}
        </p>
      ) : null}
    </li>
  );
}

export interface ValidationErrorsProps {
  errors: readonly BundleValidationError[];
  warnings: readonly BundleValidationError[];
}

export function ValidationErrors({ errors, warnings }: ValidationErrorsProps) {
  const headingId = useId();
  const groups = groupProblemsByFile(errors, warnings);
  const total = errors.length + warnings.length;

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 id={headingId} className="text-lg font-semibold">
          {errors.length > 0 ? "Validation errors" : "Validation"}
        </h2>
        <p className="text-sm text-muted-foreground">
          {total === 0
            ? "No errors or warnings."
            : `${pluralize(errors.length, "error")} and ${pluralize(warnings.length, "warning")} in ${pluralize(groups.length, "file")}.`}
        </p>
      </div>
      {total === 0 ? (
        <p className="flex items-center gap-2 text-sm">
          <CircleCheck aria-hidden="true" className="size-4 text-verdict-pass-fg" />
          The bundle passed every validation rule.
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          {groups.map((group) => (
            <section
              key={group.file}
              data-file={group.file}
              aria-label={`Problems in ${group.file}`}
              className="flex flex-col gap-2"
            >
              <h3 className="flex flex-wrap items-baseline gap-2 text-sm font-medium">
                <code className="font-mono">{group.file}</code>
                <span className="text-xs font-normal text-muted-foreground">
                  {pluralize(group.errors.length, "error")},{" "}
                  {pluralize(group.warnings.length, "warning")}
                </span>
              </h3>
              <ul className="flex flex-col gap-2">
                {[...group.errors, ...group.warnings].map((problem, index) => (
                  <ProblemItem
                    key={`${problem.severity}:${problem.code}:${problem.pointer}:${problem.line}:${index}`}
                    problem={problem}
                  />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </section>
  );
}
