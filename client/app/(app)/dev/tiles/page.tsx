import type { Metadata } from "next";
import { PageHeader } from "@/components/app-shell/page-header";
import { TileSpike } from "@/features/dev/tile-spike";
import { assertDevelopmentOnly } from "@/lib/dev-only";

export function generateMetadata(): Metadata {
  assertDevelopmentOnly();
  return { title: "Tile pipeline spike" };
}

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function TileSpikePage({ searchParams }: PageProps<"/dev/tiles">) {
  assertDevelopmentOnly();
  const query = await searchParams;
  const requestedSessions = Number(firstValue(query.sessions));
  return (
    <>
      <PageHeader
        title="Tile pipeline spike"
        description="Spike A: mock frames over the run WebSocket, latest wins, decode, one paint loop, cumulative acks."
      />
      <TileSpike
        autostart={firstValue(query.autostart) === "1"}
        initialSessions={
          Number.isFinite(requestedSessions) && requestedSessions > 0
            ? requestedSessions
            : undefined
        }
      />
    </>
  );
}
