"use client";

import { Info, Lock } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

export function ViewerNote() {
  return (
    <Alert role="status" data-slot="viewer-note">
      <Lock aria-hidden="true" />
      <AlertTitle>Read-only for viewers</AlertTitle>
      <AlertDescription>
        You can browse the catalog and the saved plans. Selecting features and starting a run needs
        the member role.
      </AlertDescription>
    </Alert>
  );
}

export interface LoadNoticesProps {
  notices: readonly string[];
  onDismiss: () => void;
}

export function LoadNotices({ notices, onDismiss }: LoadNoticesProps) {
  if (notices.length === 0) {
    return null;
  }
  return (
    <Alert role="status" data-slot="load-notices">
      <Info aria-hidden="true" />
      <AlertTitle>The saved plan did not fit this bundle exactly</AlertTitle>
      <AlertDescription>
        <ul className="list-disc pl-4">
          {notices.map((notice) => (
            <li key={notice}>{notice}</li>
          ))}
        </ul>
        <Button type="button" variant="outline" size="sm" className="mt-2" onClick={onDismiss}>
          Dismiss
        </Button>
      </AlertDescription>
    </Alert>
  );
}

export interface LoadedPlanLineProps {
  name: string | null;
  onStartNew: () => void;
}

export function LoadedPlanLine({ name, onStartNew }: LoadedPlanLineProps) {
  return (
    <div data-slot="loaded-plan" className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
      <p>
        Editing saved plan{" "}
        <span className="font-medium">{name === null ? "Untitled plan" : name}</span>
      </p>
      <Button type="button" variant="ghost" size="sm" onClick={onStartNew}>
        Start a new plan
      </Button>
    </div>
  );
}
