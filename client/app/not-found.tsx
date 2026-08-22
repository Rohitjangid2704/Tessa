import { FileQuestion } from "lucide-react";
import Link from "next/link";
import { connection } from "next/server";
import { EmptyState } from "@/components/states/empty-state";
import { Button } from "@/components/ui/button";

export default async function NotFound() {
  await connection();
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center p-6">
      <title>Page not found | Tessa</title>
      <EmptyState
        icon={FileQuestion}
        title="Page not found"
        description="The page you asked for does not exist or has moved."
        action={
          <Button asChild>
            <Link href="/">Back to Home</Link>
          </Button>
        }
      />
    </main>
  );
}
