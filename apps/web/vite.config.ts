import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const RELAY_PORT = Number(process.env.CLAW_HQ_PORT ?? 3838);

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: `http://localhost:${RELAY_PORT}`, changeOrigin: true },
      "/ws": { target: `ws://localhost:${RELAY_PORT}`, ws: true, changeOrigin: true },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
