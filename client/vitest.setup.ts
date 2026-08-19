import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, vi } from "vitest";
import { mockState } from "@/mocks/handlers";
import "@/tests/utils/dom-polyfills";
import { server } from "@/tests/utils/server";

vi.mock("@/components/editor/code-editor", () => import("@/tests/utils/mock-code-editor"));

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});

afterEach(() => {
  cleanup();
  server.resetHandlers();
  mockState.reset();
  mockState.restoreConfig();
});

afterAll(() => {
  server.close();
});
