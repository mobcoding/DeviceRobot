import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "test-dsl",
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
