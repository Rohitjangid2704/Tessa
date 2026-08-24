import { Quote } from "lucide-react";
import { cn } from "@/lib/utils";

export interface SentenceCardProps {
  sentence: string | null;
  className?: string;
}

export function SentenceCard({ sentence, className }: SentenceCardProps) {
  return (
    <figure
      data-slot="sentence-card"
      aria-label="Expected sentence"
      className={cn(
        "flex flex-col gap-2 rounded-xl border bg-card p-4 text-card-foreground",
        className,
      )}
    >
      <figcaption className="flex items-center gap-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase">
        <Quote aria-hidden="true" className="size-3.5" />
        Expected sentence
      </figcaption>
      {sentence === null ? (
        <p className="text-sm text-muted-foreground">No sentence was rendered for this result.</p>
      ) : (
        <p data-slot="sentence-text" className="text-lg leading-snug font-medium break-words">
          {sentence}
        </p>
      )}
    </figure>
  );
}
