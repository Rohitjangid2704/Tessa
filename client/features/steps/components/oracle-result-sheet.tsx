"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { ResultView, type ShownResult } from "@/features/oracle/components/result-view";
import { oracleResultQuery, oracleTemplateQuery } from "@/features/oracle/queries";

const RESULT_ID_PREVIEW_CHARACTERS = 8;

export interface OracleResultSheetProps {
  resultId: string;
  subject: string;
}

function ResultBody({ resultId }: { resultId: string }) {
  const query = useQuery(oracleResultQuery(resultId));
  const shown: ShownResult = { query, result: query.data, belongsToAnotherTemplate: false };
  return <ResultView resultId={resultId} shown={shown} />;
}

function TemplateName({ templateId }: { templateId: string }) {
  const template = useQuery(oracleTemplateQuery(templateId));
  return template.data === undefined ? null : (
    <span className="font-mono">{template.data.name}</span>
  );
}

function SheetSubject({ resultId }: { resultId: string }) {
  const query = useQuery(oracleResultQuery(resultId));
  return query.data === undefined ? null : (
    <>
      {" "}
      from template <TemplateName templateId={query.data.oracle_template_id} />
    </>
  );
}

export function OracleResultSheet({ resultId, subject }: OracleResultSheetProps) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        type="button"
        variant="link"
        size="xs"
        className="h-auto p-0 text-xs"
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        Open oracle result
        <span className="sr-only">
          {" "}
          {resultId.slice(0, RESULT_ID_PREVIEW_CHARACTERS)} for {subject}
        </span>
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-2xl">
          <SheetHeader>
            <SheetTitle>Oracle result</SheetTitle>
            <SheetDescription>
              The query result behind {subject}
              {open ? <SheetSubject resultId={resultId} /> : null}. Rows may hold personal data and
              are shown as text only.
            </SheetDescription>
          </SheetHeader>
          <div className="px-4 pb-4">{open ? <ResultBody resultId={resultId} /> : null}</div>
        </SheetContent>
      </Sheet>
    </>
  );
}
