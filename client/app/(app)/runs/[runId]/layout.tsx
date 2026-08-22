import { RunStreamProvider } from "@/features/runs/run-stream-provider";

export default async function RunLayout({
  children,
  drawer,
  params,
}: LayoutProps<"/runs/[runId]">) {
  const { runId } = await params;
  return (
    <RunStreamProvider runId={runId}>
      {children}
      {drawer}
    </RunStreamProvider>
  );
}
