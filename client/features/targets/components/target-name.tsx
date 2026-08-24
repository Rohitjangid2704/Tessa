"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { targetRoutes } from "@/lib/routes";
import { targetOptionsQuery } from "../queries";

const SHORT_ID_LENGTH = 8;

export function TargetName({ targetId }: { targetId: string | null }) {
  const options = useQuery({ ...targetOptionsQuery(), enabled: targetId !== null });
  if (targetId === null) {
    return <span className="text-muted-foreground">None</span>;
  }
  const name = options.data?.find((target) => target.id === targetId)?.name;
  return (
    <Link href={targetRoutes.detail(targetId)} className="underline-offset-4 hover:underline">
      {name ?? `Target ${targetId.slice(0, SHORT_ID_LENGTH)}`}
    </Link>
  );
}
