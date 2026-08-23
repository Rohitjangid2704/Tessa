import { describeAdapterKind } from "../registry";
import { AdapterChip } from "./adapter-chip";

export interface AdapterEnvHintsProps {
  id: string;
  kinds: readonly string[];
}

export function AdapterEnvHints({ id, kinds }: AdapterEnvHintsProps) {
  if (kinds.length === 0) {
    return null;
  }
  return (
    <ul
      id={id}
      data-slot="adapter-env-hints"
      className="flex flex-col gap-1 text-sm text-muted-foreground"
    >
      {kinds.map((kind) => (
        <li key={kind} className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <AdapterChip kind={kind} />
          <span>{describeAdapterKind(kind).envHint}</span>
        </li>
      ))}
    </ul>
  );
}
