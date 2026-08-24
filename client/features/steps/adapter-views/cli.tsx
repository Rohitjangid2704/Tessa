import { CircleCheck, CircleX } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  EmptyNote,
  FactList,
  StepNotice,
  Subsection,
  type Fact,
} from "@/features/steps/components/step-section";
import { TextView } from "@/features/steps/components/text-view";
import { formatCount, formatLatency } from "@/features/steps/format";
import type { CliStepRequest, CliStepResponse } from "@/lib/api/types";
import { hasAnsi, stripAnsi } from "@/lib/ansi";
import { describeExitCode, formatCommandLine } from "./cli-format";
import { ExtraFields } from "./extra-fields";
import { hasKind, isStringList } from "./guards";

const REQUEST_KEYS = ["kind", "argv", "cwd", "env_names"];
const RESPONSE_KEYS = ["kind", "exit_code", "stdout", "stderr", "truncated", "duration_ms"];

export function isCliRequest(value: unknown): value is CliStepRequest {
  return hasKind(value, "cli") && isStringList(value.argv) && isStringList(value.env_names);
}

export function isCliResponse(value: unknown): value is CliStepResponse {
  return (
    hasKind(value, "cli") &&
    typeof value.exit_code === "number" &&
    typeof value.stdout === "string" &&
    typeof value.stderr === "string" &&
    typeof value.truncated === "boolean" &&
    typeof value.duration_ms === "number"
  );
}

export function CliRequestView({ request }: { request: CliStepRequest }) {
  const [command = null] = request.argv;
  const facts: Fact[] = [
    { label: "Command", value: command ?? "No command was recorded", mono: command !== null },
    { label: "Arguments", value: formatCount(Math.max(request.argv.length - 1, 0)) },
  ];
  if (request.cwd !== null && request.cwd !== undefined) {
    facts.push({ label: "Working directory", value: request.cwd, mono: true });
  }
  return (
    <div data-slot="cli-request" className="flex flex-col gap-4">
      <FactList facts={facts} />
      {request.argv.length > 0 ? (
        <TextView label="Command line" text={formatCommandLine(request.argv)} />
      ) : null}
      <Subsection title="Environment variable names">
        {request.env_names.length === 0 ? (
          <EmptyNote compact>No environment variables were passed to the command.</EmptyNote>
        ) : (
          <div className="flex flex-col gap-1.5">
            <ul
              aria-label="Environment variable names"
              data-slot="cli-env-names"
              className="flex flex-wrap gap-1"
            >
              {request.env_names.map((name) => (
                <li key={name}>
                  <Badge variant="outline" className="font-mono">
                    {name}
                  </Badge>
                </li>
              ))}
            </ul>
            <p className="text-xs text-muted-foreground">
              Only the names are recorded. The values are never stored in a step.
            </p>
          </div>
        )}
      </Subsection>
      <ExtraFields payload={request} knownKeys={REQUEST_KEYS} />
    </div>
  );
}

function ExitCodeBadge({ exitCode }: { exitCode: number }) {
  const succeeded = exitCode === 0;
  const Icon = succeeded ? CircleCheck : CircleX;
  return (
    <Badge variant={succeeded ? "outline" : "destructive"}>
      <Icon aria-hidden="true" />
      {`${exitCode} ${describeExitCode(exitCode)}`}
    </Badge>
  );
}

interface OutputBlockProps {
  label: string;
  text: string;
  emptyText: string;
}

function OutputBlock({ label, text, emptyText }: OutputBlockProps) {
  const visibleText = stripAnsi(text);
  if (visibleText === "") {
    return (
      <Subsection title={label}>
        <EmptyNote compact>{emptyText}</EmptyNote>
      </Subsection>
    );
  }
  return <TextView label={label} text={visibleText} />;
}

export function CliResponseView({ response }: { response: CliStepResponse }) {
  const hadEscapes = hasAnsi(response.stdout) || hasAnsi(response.stderr);
  return (
    <div data-slot="cli-response" className="flex flex-col gap-4">
      <FactList
        facts={[
          { label: "Exit code", value: <ExitCodeBadge exitCode={response.exit_code} /> },
          { label: "Duration", value: formatLatency(response.duration_ms) },
        ]}
      />
      {response.truncated ? (
        <StepNotice tone="warning" title="Output truncated">
          The recorded output was cut at the storage limit, so its end is missing. Do not read a
          missing line as a defect until you know the output was complete.
        </StepNotice>
      ) : null}
      <OutputBlock
        label="Standard output"
        text={response.stdout}
        emptyText="The command wrote nothing to standard output."
      />
      <OutputBlock
        label="Standard error"
        text={response.stderr}
        emptyText="The command wrote nothing to standard error."
      />
      {hadEscapes ? (
        <p data-slot="ansi-note" className="text-xs text-muted-foreground">
          Terminal colour and cursor codes were removed from the output shown here.
        </p>
      ) : null}
      <ExtraFields payload={response} knownKeys={RESPONSE_KEYS} />
    </div>
  );
}
