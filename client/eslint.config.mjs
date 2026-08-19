import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "coverage/**",
    "next-env.d.ts",
    "lib/api/schema.d.ts",
    "public/mockServiceWorker.js",
    "playwright-report/**",
    "test-results/**",
    ".vitest/**",
    "mocks/.cache/**",
  ]),
]);

export default eslintConfig;
