import { defineConfig, type Plugin } from "vite";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";

// Ship the preview Service Worker with the package. Its canonical copy lives in
// the studio app (served there from `public/sw.js`); we vendor it into the SDK's
// `dist/assets/sw.js` at build time so a consumer can host it same-origin at
// `/sw.js` (see `Vivari.boot({ serviceWorkerUrl })`). One source of truth, shipped
// with the library.
function bundleServiceWorker(): Plugin {
  const src = fileURLToPath(new URL("../studio/public/sw.js", import.meta.url));
  return {
    name: "vivari-bundle-sw",
    closeBundle() {
      const outDir = fileURLToPath(new URL("./dist/assets", import.meta.url));
      fs.mkdirSync(outDir, { recursive: true });
      fs.copyFileSync(src, path.join(outDir, "sw.js"));
    },
  };
}

// The official SQLite package contains optional standalone and OPFS-proxy worker
// front doors. We use neither: SQL and persistence are kernel-owned. Remove these
// constructor sites during compilation (not by editing dependency/generated
// files), so static emitted-asset inventories cannot treat them as active roles.
// Preserve the upstream module/license; fail closed if its pinned glue changes.
function kernelOnlySqlite(): Plugin {
  return {
    name: "vivari-kernel-only-sqlite",
    enforce: "pre",
    transform(code, id) {
      if (!id.includes("@sqlite.org/sqlite-wasm/")) return;
      let site: RegExp;
      if (id.endsWith("/sqlite3-bundler-friendly.mjs")) {
        site = /new Worker\(\s*new URL\('sqlite3-opfs-async-proxy\.js', import\.meta\.url\),\s*\)/g;
      } else if (id.endsWith("/sqlite3-worker1-promiser.mjs")) {
        site = /new Worker\(\s*new URL\('sqlite3-worker1-bundler-friendly\.mjs', import\.meta\.url\),\s*\{\s*type: 'module',\s*\},\s*\)/g;
      } else return;
      const matches = code.match(site);
      if (matches?.length !== 1) throw new Error(`Unexpected SQLite worker glue in ${id}`);
      return {
        code: code.replace(site, "(() => { throw new Error('Auxiliary SQLite workers are unavailable: the Vivari kernel owns SQL and persistence'); })()"),
        map: null,
      };
    },
  };
}

// Library build for @vivari/core.
//
// The public entry (`src/index.ts`) only pulls in framework-agnostic TS. The
// heavy machinery — the kernel worker and its nested fs/fetcher/process workers,
// plus the Rust/Wasm VFS + codec + crypto artifacts — is reached exclusively
// through `new Worker(new URL('./workers/*.ts', import.meta.url))` and
// `new URL('../../<crate>/pkg/*_bg.wasm', import.meta.url)`. Vite follows those
// recursively, bundling each worker as its own chunk and emitting the wasm as
// hashed assets under `dist/assets/`, with every URL rewritten to sit beside the
// installed package. That makes the published `dist/` fully self-contained: a
// consumer's bundler resolves the workers/wasm relative to node_modules, no
// separate asset-hosting step required.
export default defineConfig({
  // Worker/WASM URLs stay relative to the distribution mount.
  base: "./",
  plugins: [bundleServiceWorker(), kernelOnlySqlite()],
  build: {
    target: "es2022",
    outDir: "dist",
    emptyOutDir: true,
    minify: false,
    lib: {
      entry: {
        index: fileURLToPath(new URL("./src/index.ts", import.meta.url)),
        host: fileURLToPath(new URL("./src/host-sdk/index.ts", import.meta.url)),
      },
      formats: ["es"],
      fileName: (_format, name) => `${name}.js`,
    },
    rollupOptions: {
      output: {
        // Keep worker/wasm asset names stable-ish and grouped for readability.
        assetFileNames: "assets/[name]-[hash][extname]",
        chunkFileNames: "assets/[name]-[hash].js",
      },
    },
  },
  worker: { format: "es", plugins: () => [kernelOnlySqlite()] },
});
