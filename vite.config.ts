import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

export default defineConfig({
  root: "src/web",
  plugins: [react(), {
    name: "precompress-static-assets",
    apply: "build",
    async closeBundle() {
      const assets = new URL("./dist/web/assets/", import.meta.url);
      for (const name of await readdir(assets)) {
        if (!/\.(js|css)$/.test(name)) continue;
        const source = await readFile(new URL(name, assets));
        if (source.length < 1024) continue;
        await Promise.all([
          writeFile(new URL(`${name}.br`, assets), brotliCompressSync(source, { params: { [constants.BROTLI_PARAM_QUALITY]: 5 } })),
          writeFile(new URL(`${name}.gz`, assets), gzipSync(source, { level: 6 }))
        ]);
      }
    }
  }],
  build: { outDir: "../../dist/web", emptyOutDir: true },
  server: {
    port: 4312,
    proxy: {
      "^/api/": { target: "http://127.0.0.1:43110", ws: true }
    }
  }
});
