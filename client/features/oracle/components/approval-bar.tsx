"use client";

import { Check, X } from "lucide-react";
import { useId } from "react";
import { readRequestId } from "@/components/states/request-id";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { describeApiError } from "@/lib/api/errors";
import { useSetApproval } from "../mutations";
import { APPROVAL_LABELS } from "../schemas";
import type { OracleResult, OracleTemplate } from "../types";
import { ApprovalBadge } from "./oracle-badges";

const ALLOWED_HINT =
  "Approve this template if the rows and the sentence of the result on screen are right, or reject it.";

export type ApprovalGate = { allowed: true } | { allowed: false; reason: string };

export interface ApprovalGateInput {
  canReview: boolean;
  accessKnown: boolean;
  template: Pick<OracleTemplate, "read_only_verified">;
  result: Pick<OracleResult, "status"> | undefined;
}

export function approvalGate({
  canReview,
  accessKnown,
  template,
  result,
}: ApprovalGateInput): ApprovalGate {
  if (accessKnown && !canReview) {
    return {
      allowed: false,
      reason: "Your role is viewer, so you cannot approve or reject. A member can.",
    };
  }
  if (!template.read_only_verified) {
    return {
      allowed: false,
      reason:
        "This template is not verified as read-only, so it cannot be approved or rejected. Fix the query in the bundle and upload it again.",
    };
  }
  if (result === undefined) {
    return { allowed: false, reason: "Run the query and review its rows before you decide." };
  }
  if (result.status === "pending") {
    return { allowed: false, reason: "Wait for the run to finish, then review its rows." };
  }
  if (result.status === "error") {
    return {
      allowed: false,
      reason: "The run on screen failed. Run the query again and review a result that finished.",
    };
  }
  return { allowed: true };
}

export interface ApprovalBarProps {
  template: OracleTemplate;
  result: OracleResult | undefined;
  canReview: boolean;
  accessKnown: boolean;
}

export function ApprovalBar({ template, result, canReview, accessKnown }: ApprovalBarProps) {
  const headingId = useId();
  const reasonId = useId();
  const mutation = useSetApproval(template.id);
  const gate = approvalGate({ canReview, accessKnown, template, result });
  const busy = mutation.isPending;

  function decide(approved: boolean): void {
    if (result !== undefined) {
      mutation.mutate({ approved, oracleResultId: result.id });
    }
  }

  const decided = mutation.data;
  return (
    <section
      data-slot="approval-bar"
      aria-labelledby={headingId}
      className="flex flex-col gap-3 rounded-xl border p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={headingId} className="text-sm font-semibold">
          Review
        </h3>
        <ApprovalBadge approval={template.approval} />
      </div>
      <p id={reasonId} className="text-sm text-muted-foreground">
        {gate.allowed ? ALLOWED_HINT : gate.reason}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          disabled={!gate.allowed || busy || template.approval === "approved"}
          aria-describedby={reasonId}
          onClick={() => decide(true)}
        >
          <Check aria-hidden="true" data-icon="inline-start" />
          Approve
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={!gate.allowed || busy || template.approval === "rejected"}
          aria-describedby={reasonId}
          onClick={() => decide(false)}
        >
          <X aria-hidden="true" data-icon="inline-start" />
          Reject
        </Button>
      </div>
      <p role="status" className="text-sm font-medium empty:hidden">
        {decided === undefined
          ? ""
          : `${decided.name} is now ${APPROVAL_LABELS[decided.approval].toLowerCase()}.`}
      </p>
      {mutation.isError ? (
        <Alert variant="destructive">
          <AlertTitle>Could not save the decision</AlertTitle>
          <AlertDescription>
            {describeApiError(mutation.error)}
            {readRequestId(mutation.error) === null
              ? null
              : ` Request ID: ${readRequestId(mutation.error)}`}
          </AlertDescription>
        </Alert>
      ) : null}
    </section>
  );
}
