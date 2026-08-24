import { JsonView } from "@/features/steps/components/json-view";
import { Subsection } from "@/features/steps/components/step-section";
import { extraFieldsOf } from "./guards";

export interface ExtraFieldsProps {
  payload: object;
  knownKeys: readonly string[];
}

export function ExtraFields({ payload, knownKeys }: ExtraFieldsProps) {
  const extras = extraFieldsOf(payload, knownKeys);
  if (extras === null) {
    return null;
  }
  return (
    <Subsection title="Additional fields">
      <JsonView value={extras} label="Additional fields in the payload" defaultOpenDepth={1} />
    </Subsection>
  );
}
