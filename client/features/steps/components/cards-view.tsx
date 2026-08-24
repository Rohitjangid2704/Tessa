import { Badge } from "@/components/ui/badge";
import type { Step } from "@/lib/api/types";
import { JsonView } from "./json-view";
import { StepSection } from "./step-section";

type StepCard = Step["cards"][number];

function readText(card: StepCard, key: string): string | null {
  const value = card[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function cardBody(card: StepCard, kind: string | null, title: string | null): StepCard {
  return Object.fromEntries(
    Object.entries(card).filter(
      ([key]) => !(key === "kind" && kind !== null) && !(key === "title" && title !== null),
    ),
  );
}

function CardItem({ card, position }: { card: StepCard; position: number }) {
  const kind = readText(card, "kind");
  const title = readText(card, "title");
  const body = cardBody(card, kind, title);
  const hasBody = Object.keys(body).length > 0;

  return (
    <li data-slot="card-item" className="flex min-w-0 flex-col gap-2 rounded-lg border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="text-sm font-medium wrap-anywhere">{title ?? `Card ${position}`}</h4>
        {kind === null ? null : <Badge variant="outline">{kind}</Badge>}
      </div>
      {hasBody ? (
        <JsonView value={body} label={`Card ${position} data`} />
      ) : (
        <p className="text-xs text-muted-foreground">This card carried no other data.</p>
      )}
    </li>
  );
}

export function CardsView({ cards }: { cards: Step["cards"] }) {
  if (cards.length === 0) {
    return null;
  }
  return (
    <StepSection title="Cards">
      <ol data-slot="cards-list" className="flex flex-col gap-2">
        {cards.map((card, index) => (
          <CardItem key={index} card={card} position={index + 1} />
        ))}
      </ol>
    </StepSection>
  );
}
