import type { Metadata } from "next";
import { PageHeader } from "@/components/app-shell/page-header";
import { HelloPlayground } from "@/features/hello/hello-playground";

export const metadata: Metadata = { title: "Hello stream" };

const RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function readRunId(value: string | string[] | undefined): string | null {
  const candidate = Array.isArray(value) ? value[0] : value;
  return candidate !== undefined && RUN_ID_PATTERN.test(candidate) ? candidate : null;
}

export default async function HelloPage({ searchParams }: PageProps<"/dev/hello">) {
  const query = await searchParams;
  return (
    <>
      <PageHeader
        title="Hello stream"
        description="Starts a hello workflow, opens the run WebSocket and lists the events in order. A reload with ?run_id= resumes the same run."
      />
      <HelloPlayground initialRunId={readRunId(query.run_id)} />
    </>
  );
}
