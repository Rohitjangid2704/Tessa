"use client";

import { CopyButton } from "@/components/copy-button";
import { DateTime } from "@/components/date-time";
import { DiffView } from "@/components/diff-view";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { Scenario } from "@/lib/api/types";

export type ConflictDialogProps = {
  theirs: Scenario | null;
  mine: string;
  onReload: () => void;
  onRebase: () => void;
  onKeepEditing: () => void;
};

export function ConflictDialog({
  theirs,
  mine,
  onReload,
  onRebase,
  onKeepEditing,
}: ConflictDialogProps) {
  return (
    <Dialog open={theirs !== null} onOpenChange={(open) => (open ? undefined : onKeepEditing())}>
      <DialogContent className="sm:max-w-3xl" data-slot="conflict-dialog">
        <DialogHeader>
          <DialogTitle>Someone saved a newer version</DialogTitle>
          <DialogDescription>
            {theirs === null ? null : (
              <>
                Version {theirs.version} was saved <DateTime value={theirs.updated_at} /> while you
                were editing. Nothing of yours was lost: choose what happens to your text.
              </>
            )}
          </DialogDescription>
        </DialogHeader>
        {theirs === null ? null : (
          <DiffView
            original={theirs.yaml}
            modified={mine}
            originalLabel={`Theirs, version ${theirs.version}`}
            modifiedLabel="Mine, unsaved"
            label="Theirs against mine"
          />
        )}
        <ul className="flex flex-col gap-1 text-sm text-muted-foreground">
          <li>
            <strong className="font-medium text-foreground">Reload</strong> discards your edits and
            shows their version.
          </li>
          <li>
            <strong className="font-medium text-foreground">Rebase</strong> keeps your text and
            saves it on top of their version when you press Save.
          </li>
          <li>
            <strong className="font-medium text-foreground">Copy mine</strong> puts your text on the
            clipboard so you can merge it by hand.
          </li>
        </ul>
        <DialogFooter>
          <CopyButton text={mine} subject="your unsaved YAML" />
          <Button type="button" variant="outline" onClick={onReload}>
            Reload
          </Button>
          <Button type="button" onClick={onRebase}>
            Rebase
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
