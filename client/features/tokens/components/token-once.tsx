"use client";

import { KeyRound, TriangleAlert } from "lucide-react";
import { useId } from "react";
import { CopyButton } from "@/components/copy-button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export type TokenOnceProps = {
  tokenName: string;
  token: string;
  onDone: () => void;
};

export function TokenOnce({ tokenName, token, onDone }: TokenOnceProps) {
  const fieldId = useId();
  return (
    <div data-slot="token-once" className="grid min-w-0 gap-4">
      <DialogHeader>
        <DialogTitle>Token created</DialogTitle>
        <DialogDescription>
          Copy the token for <span className="font-medium">{tokenName}</span> now and paste it into
          Claude Code when the plugin asks for it.
        </DialogDescription>
      </DialogHeader>
      <Alert>
        <TriangleAlert aria-hidden="true" />
        <AlertTitle>This token is shown once</AlertTitle>
        <AlertDescription>
          Tessa keeps only a hash. After you close this dialog nobody, including you, can see
          the token again. If you lose it, revoke it and create a new one.
        </AlertDescription>
      </Alert>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={fieldId}>Personal token</Label>
        <div className="flex items-center gap-2">
          <Input
            id={fieldId}
            readOnly
            value={token}
            autoComplete="off"
            spellCheck={false}
            data-slot="token-once-value"
            className="font-mono"
            onFocus={(event) => event.currentTarget.select()}
          />
          <CopyButton text={token} subject="token" />
        </div>
      </div>
      <DialogFooter>
        <Button type="button" onClick={onDone}>
          <KeyRound aria-hidden="true" data-icon="inline-start" />I copied it
        </Button>
      </DialogFooter>
    </div>
  );
}
