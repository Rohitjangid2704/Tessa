"use client";

import { FileJson } from "lucide-react";
import { CopyButton } from "@/components/copy-button";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import type { Run } from "@/lib/api/types";

const JSON_INDENT = 2;

export function RunConfigSnapshot({ run }: { run: Run }) {
  const text = JSON.stringify(run.config_snapshot, null, JSON_INDENT);
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size="sm">
          <FileJson aria-hidden="true" data-icon="inline-start" />
          Config snapshot
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Config snapshot</DialogTitle>
          <DialogDescription>
            The bundle, seed, clock, models and prompt versions this run was pinned to. It never
            changes after the run starts.
          </DialogDescription>
        </DialogHeader>
        <pre
          tabIndex={0}
          aria-label="Config snapshot JSON"
          className="max-h-[60vh] overflow-auto rounded-lg bg-muted p-3 font-mono text-xs whitespace-pre-wrap"
        >
          {text}
        </pre>
        <DialogFooter showCloseButton>
          <CopyButton text={text} subject="config snapshot" />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
