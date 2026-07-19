import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "src/web",
  plugins: [react()],
  build: { outDir: "../../dist/web", emptyOutDir: true },
  server: {
    port: 4312,
    proxy: {
      "/api": { target: "http://127.0.0.1:4311", ws: true }
    }
  }
});
