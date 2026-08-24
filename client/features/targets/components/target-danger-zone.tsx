"use client";

import { Archive } from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { DateTime } from "@/components/date-time";
import { RoleGate } from "@/components/role-gate";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { describeApiError, isApiError } from "@/lib/api/errors";
import { targetRoutes } from "@/lib/routes";
import { useArchiveTarget } from "../mutations";
import type { Target } from "../types";

export function describeArchiveError(error: unknown): string {
  if (isApiError(error) && error.status === 403) {
    return "Only an admin can archive a target.";
  }
  return describeApiError(error);
}

export function TargetDangerZone({ target }: { target: Target }) {
  const router = useRouter();
  const archive = useArchiveTarget(target.id);
  const archived = target.archived_at != null;

  return (
    <RoleGate action="targets.archive">
      <Card data-slot="target-danger-zone" className="ring-destructive/30">
        <CardHeader>
          <CardTitle role="heading" aria-level={2}>
            Danger zone
          </CardTitle>
          <CardDescription>
            Archiving hides the target from the default list and blocks new prompts, uploads and
            edits. Its bundles and history stay readable. There is no unarchive in the app.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {archive.isError ? (
            <Alert variant="destructive">
              <AlertDescription>{describeArchiveError(archive.error)}</AlertDescription>
            </Alert>
          ) : null}
          {archived ? (
            <p className="text-sm text-muted-foreground">
              Archived <DateTime value={target.archived_at} />.
            </p>
          ) : (
            <div>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    disabled={archive.isPending}
                  >
                    <Archive aria-hidden="true" data-icon="inline-start" />
                    {archive.isPending ? "Archiving" : "Archive target"}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Archive {target.name}?</AlertDialogTitle>
                    <AlertDialogDescription>
                      The target leaves the default list and can no longer issue prompts, take
                      uploads or be edited. Past bundles stay readable.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      variant="destructive"
                      onClick={() =>
                        archive.mutate(undefined, {
                          onSuccess: () => {
                            toast.success(`${target.name} archived`);
                            router.push(targetRoutes.list());
                          },
                        })
                      }
                    >
                      Archive target
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          )}
        </CardContent>
      </Card>
    </RoleGate>
  );
}
