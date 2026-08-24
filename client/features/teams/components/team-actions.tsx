"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { Team } from "@/lib/api/types";
import { BudgetEditor } from "./budget-editor";
import { MembersEditor } from "./members-editor";
import { TeamFormDialog } from "./team-form-dialog";

type OpenDialog = "rename" | "members" | "budget" | null;

export function TeamActions({ team }: { team: Team }) {
  const [open, setOpen] = useState<OpenDialog>(null);

  function close(): void {
    setOpen(null);
  }

  return (
    <div data-slot="team-actions" className="flex flex-wrap justify-end gap-1">
      <Button
        type="button"
        variant="outline"
        size="sm"
        aria-label={`Rename ${team.name}`}
        onClick={() => setOpen("rename")}
      >
        Rename
      </Button>
      <Button
        type="button"
        variant="outline"
        size="sm"
        aria-label={`Members of ${team.name}`}
        onClick={() => setOpen("members")}
      >
        Members
      </Button>
      <Button
        type="button"
        variant="outline"
        size="sm"
        aria-label={`Budget for ${team.name}`}
        onClick={() => setOpen("budget")}
      >
        Budget
      </Button>
      {open === "rename" ? <TeamFormDialog team={team} onClose={close} /> : null}
      {open === "members" ? <MembersEditor team={team} onClose={close} /> : null}
      {open === "budget" ? <BudgetEditor team={team} onClose={close} /> : null}
    </div>
  );
}
