"use client";

import { KeyRound } from "lucide-react";
import { useId } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { SettingsRead } from "@/lib/api/types";
import { SECRET_DEFINITIONS } from "../schemas";
import { SecretField } from "./secret-field";

export interface SecretsCardProps {
  settings: SettingsRead;
  readOnly: boolean;
}

export function SecretsCard({ settings, readOnly }: SecretsCardProps) {
  const titleId = useId();
  return (
    <Card role="region" aria-labelledby={titleId} data-section="secrets">
      <CardHeader>
        <CardTitle id={titleId} role="heading" aria-level={2} className="flex items-center gap-2">
          <KeyRound aria-hidden="true" className="size-4" />
          Secrets
        </CardTitle>
        <CardDescription>
          Keys are write-only: Tessa stores them encrypted and never shows them again. A key
          stored here takes over from the one in the deployment environment.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ul aria-label="Secret keys" className="flex flex-col divide-y">
          {SECRET_DEFINITIONS.map((definition) => (
            <SecretField
              key={definition.name}
              definition={definition}
              status={settings.secrets[definition.name]}
              readOnly={readOnly}
            />
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
