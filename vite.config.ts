import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";

export default defineConfig({
  root: "src/web",
  plugins: [react(), {
    name: "precompress-static-assets",
    apply: "build",
    configResolved(config) {
      if (path.resolve(config.root, config.build.outDir) === fileURLToPath(new URL("./dist/web", import.meta.url))) {
        throw new Error("Refusing to build into the serving directory. Use npm run build for staged publication.");
      }
    },
    async writeBundle(output) {
      const assets = path.join(output.dir!, "assets");
      for (const name of await readdir(assets)) {
        if (!/\.(js|css)$/.test(name)) continue;
        const source = await readFile(path.join(assets, name));
        if (source.length < 1024) continue;
        await Promise.all([
          writeFile(path.join(assets, `${name}.br`), brotliCompressSync(source, { params: { [constants.BROTLI_PARAM_QUALITY]: 5 } })),
          writeFile(path.join(assets, `${name}.gz`), gzipSync(source, { level: 6 }))
        ]);
      }
    }
  }],
  // Direct `vite build` must never empty the directory served by the live app.
  // `npm run build` uses a unique staging directory and publishes HTML last.
  build: { outDir: "../../dist/web-build", emptyOutDir: true, manifest: true },
  server: {
    port: 4312,
    proxy: {
      "^/api/": { target: "http://127.0.0.1:43110", ws: true }
    }
  }
});
