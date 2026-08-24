"use client";

import { KeyRound, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { CopyButton } from "@/components/copy-button";
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
import { useRotateTargetToken } from "../mutations";
import type { Target } from "../types";

export function describeRotateError(error: unknown): string {
  if (isApiError(error) && error.status === 409) {
    return "This target is archived, so its token cannot be rotated.";
  }
  if (isApiError(error) && error.status === 403) {
    return "Your role cannot rotate the token. Ask a member or an admin.";
  }
  return describeApiError(error);
}

export function TokenCard({ target }: { target: Target }) {
  const rotate = useRotateTargetToken(target.id);
  const archived = target.archived_at != null;

  return (
    <Card data-slot="token-card">
      <CardHeader>
        <CardTitle role="heading" aria-level={2}>
          Target token
        </CardTitle>
        <CardDescription>
          Names this target in the bundle manifest so uploads find it. It routes uploads and is not
          a secret.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <code className="min-w-0 rounded bg-muted px-2 py-1 font-mono text-xs break-all">
            {target.target_token}
          </code>
          <CopyButton text={target.target_token} subject="target token" size="sm" />
        </div>
        {rotate.isError ? (
          <Alert variant="destructive">
            <TriangleAlert aria-hidden="true" />
            <AlertDescription>{describeRotateError(rotate.error)}</AlertDescription>
          </Alert>
        ) : null}
        <RoleGate action="targets.rotate_token">
          <div>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={archived || rotate.isPending}
                >
                  <KeyRound aria-hidden="true" data-icon="inline-start" />
                  {rotate.isPending ? "Rotating" : "Rotate token"}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Rotate the token of {target.name}?</AlertDialogTitle>
                  <AlertDialogDescription>
                    A new token is issued. The current one keeps matching uploads until the next
                    rotation, so bundles Claude Code already wrote still upload. Prompts issued
                    earlier keep the old token in their text.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={() =>
                      rotate.mutate(undefined, {
                        onSuccess: () => toast.success("Target token rotated"),
                      })
                    }
                  >
                    Rotate token
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </RoleGate>
      </CardContent>
    </Card>
  );
}
