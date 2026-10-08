import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: Object.fromEntries(
      ["/api", "/openai", "/mcp-tools"].map((path) => [
        path,
        { target: "http://127.0.0.1:3001", changeOrigin: false },
      ]),
    ),
  },
  test: {
    environment: "jsdom",
    testTimeout: 15_000,
    setupFiles: ["./src/test/setup.ts"],
    clearMocks: true,
    restoreMocks: true,
  },
});
