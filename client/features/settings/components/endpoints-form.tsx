"use client";

import { Link2 } from "lucide-react";
import { FieldGroup } from "@/components/ui/field";
import type { SettingsRead } from "@/lib/api/types";
import { findLeafSpec } from "../schemas";
import { LeafField } from "./leaf-controls";
import { SettingsSection } from "./settings-section";

export interface EndpointsFormProps {
  settings: SettingsRead;
  readOnly: boolean;
}

const ENDPOINT_FIELDS = [
  {
    leaf: "laya_url",
    description: "Where the grader answers typed questions, for example http://127.0.0.1:7006.",
  },
  {
    leaf: "jev_url",
    description:
      "Optional second opinion. Leave it empty to keep Jev off; there is no default to fall back to.",
  },
] as const;

export function EndpointsForm({ settings, readOnly }: EndpointsFormProps) {
  return (
    <SettingsSection
      group="endpoints"
      title="Endpoints"
      description="The services Tessa calls from the worker."
      icon={Link2}
      settings={settings}
      readOnly={readOnly}
    >
      {(api) => (
        <FieldGroup>
          {ENDPOINT_FIELDS.map((field) => (
            <LeafField
              key={field.leaf}
              api={api}
              spec={findLeafSpec("endpoints", field.leaf)}
              description={field.description}
            />
          ))}
        </FieldGroup>
      )}
    </SettingsSection>
  );
}
