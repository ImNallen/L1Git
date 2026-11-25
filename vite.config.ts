import { defaultClientConditions, defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  // Without a document, as in a worker, a module must not expect one.
  resolve: { conditions: ["worker", ...defaultClientConditions] },
  server: {
    host: "127.0.0.1",
    port: Number(process.env.L1GIT_DEV_PORT ?? 1422),
    strictPort: true,
    cors: false,
    proxy: {
      "/api": `http://127.0.0.1:${process.env.L1GIT_BRIDGE_PORT ?? 9417}`,
    },
  },
  build: { target: "es2022" },
});
