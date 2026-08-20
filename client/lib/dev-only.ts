import { notFound } from "next/navigation";

export function assertDevelopmentOnly(): void {
  if (process.env.NODE_ENV === "production") {
    notFound();
  }
}
