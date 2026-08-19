import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const ignoredByEveryProject = ["node_modules/**", ".next/**", "tests/e2e/**"];

export default defineConfig({
  plugins: [react()],
  resolve: { tsconfigPaths: true },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          environment: "jsdom",
          include: ["**/*.test.{ts,tsx}"],
          exclude: [...ignoredByEveryProject, "mocks/server/**"],
          setupFiles: ["./vitest.setup.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "mock-server",
          environment: "node",
          include: ["mocks/server/**/*.test.ts"],
          exclude: ignoredByEveryProject,
        },
      },
    ],
  },
});
