import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "agent",
    environment: "node",
    include: ["test/**/*.test.ts"],
    testTimeout: 15_000,
  },
});
