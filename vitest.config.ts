import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["scripts/**/*.test.ts", "src/**/*.test.ts", "tests/**/*.test.ts"],
    exclude: ["tests/browser-smoke.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}", "scripts/**/*.ts"],
      exclude: ["scripts/**/*.test.ts", "src/**/*.test.ts"],
      reporter: ["text", "json-summary"],
      thresholds: {
        statements: 50,
        branches: 38,
        functions: 38,
        lines: 52,
      },
    },
  },
});
