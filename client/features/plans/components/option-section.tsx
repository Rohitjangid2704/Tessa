import type { ReactNode } from "react";
import { FieldDescription, FieldLegend, FieldSet } from "@/components/ui/field";

export interface OptionSectionProps {
  title: string;
  description?: string;
  children: ReactNode;
}

export function OptionSection({ title, description, children }: OptionSectionProps) {
  return (
    <FieldSet className="gap-2">
      <FieldLegend variant="label" className="mb-0">
        {title}
      </FieldLegend>
      {description === undefined ? null : <FieldDescription>{description}</FieldDescription>}
      {children}
    </FieldSet>
  );
}
