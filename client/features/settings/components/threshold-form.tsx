"use client";

import { Gauge } from "lucide-react";
import { FieldGroup } from "@/components/ui/field";
import type { SettingsRead } from "@/lib/api/types";
import { findLeafSpec } from "../schemas";
import { LeafField } from "./leaf-controls";
import { SettingsSection } from "./settings-section";

export interface ThresholdFormProps {
  settings: SettingsRead;
  readOnly: boolean;
}

const THRESHOLD_FIELDS = [
  {
    leaf: "probe_confidence",
    description:
      "The confidence a Laya probe needs before its answer decides a step. A number from 0 to 1.",
  },
  {
    leaf: "judge_escalate_below",
    description:
      "Probe confidence below this value sends the step to the judge. A number from 0 to 1.",
  },
  {
    leaf: "label_audit_rate",
    description:
      "The share of machine-graded steps added to the label queue at random for audit. A number from 0 to 1.",
  },
] as const;

export function ThresholdForm({ settings, readOnly }: ThresholdFormProps) {
  return (
    <SettingsSection
      group="thresholds"
      title="Thresholds"
      description="When a probe answer is trusted, when a step escalates and how often humans audit the machine."
      icon={Gauge}
      settings={settings}
      readOnly={readOnly}
    >
      {(api) => (
        <FieldGroup>
          {THRESHOLD_FIELDS.map((field) => (
            <LeafField
              key={field.leaf}
              api={api}
              spec={findLeafSpec("thresholds", field.leaf)}
              description={field.description}
            />
          ))}
        </FieldGroup>
      )}
    </SettingsSection>
  );
}
