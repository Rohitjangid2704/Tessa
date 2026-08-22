import type { Metadata } from "next";
import { assertDevelopmentOnly } from "@/lib/dev-only";
import { EditorSpike } from "./editor-spike";

export function generateMetadata(): Metadata {
  assertDevelopmentOnly();
  return { title: "Editor spike" };
}

export default function EditorSpikePage() {
  assertDevelopmentOnly();
  return <EditorSpike />;
}
