import { defineConfig } from "vite";
import { nodePolyfills } from "vite-plugin-node-polyfills";

export default defineConfig({
  plugins: [
    nodePolyfills({
      globals: { Buffer: true, global: true, process: true },
    }),
  ],
  server: {
    port: 5173,
    host: "0.0.0.0",
  },
  optimizeDeps: {
    include: ["@circle-fin/app-kit", "@circle-fin/adapter-viem-v2"],
  },
  build: {
    target: "esnext",
  },
});
