import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { execSync } from "node:child_process";

const RELAY_PORT = Number(process.env.CLAW_HQ_PORT ?? 3838);

function gitSha(): string {
  try {
    return execSync("git rev-parse --short=8 HEAD", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return "unknown";
  }
}

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_BUILD_TIME__: JSON.stringify(new Date().toISOString()),
    __APP_GIT_SHA__: JSON.stringify(gitSha()),
  },
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
