import path from "path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { createUiDevWatchOptions } from "./src/lib/vite-watch";

export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss()],
  build: {
    minify: "esbuild",
    // Split common vendor deps into their own chunks so they cache
    // independently of route changes. Pre-split, the biggest offender was
    // `index-FWfI3djl.js` at ~3.6 MB un-gzipped — a single mega-chunk that
    // forced the browser to re-download the whole app on any change.
    //
    // Heavy domain libs (mermaid, cytoscape, katex, treemap) are already
    // split by Rollup automatically because they are dynamically imported
    // by their consumers. The lists here cover foundational deps that
    // don't dynamically import — bundling them together is fine because
    // every page uses them.
    rollupOptions: {
      output: {
        manualChunks: {
          react: ["react", "react-dom"],
          "react-query": ["@tanstack/react-query"],
          router: ["react-router-dom"],
          markdown: ["react-markdown", "remark-gfm"],
        },
      },
    },
  },
  esbuild:
    mode === "production"
      ? {
          drop: ["console", "debugger"],
          legalComments: "none",
        }
      : undefined,
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      lexical: path.resolve(__dirname, "./node_modules/lexical/Lexical.mjs"),
    },
  },
  server: {
    port: 5173,
    watch: createUiDevWatchOptions(process.cwd()),
    proxy: {
      "/api": {
        target: "http://localhost:3100",
        ws: true,
      },
    },
  },
}));
