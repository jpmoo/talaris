import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * Built to static files beside the drawer's own pages, and served by the same
 * scheme — there is no web server. `base: "./"` because the bundle is loaded
 * from `talaris-ui://ui/canvas/index.html` and an absolute `/assets/…` would
 * be asked of the wrong directory.
 */
export default defineConfig({
  base: "./",
  plugins: [react()],
  resolve: {
    /*
     * The pieces of Hermes' app the canvas expects to be inside.
     *
     * Aliased rather than edited into the component: `CanvasView.tsx` is a
     * fork, and every line changed in it is a line to merge by hand the next
     * time Hermes' canvas learns something. The shims say what Talaria answers
     * instead — no router, no shared package, and a block card that is a card
     * rather than an editor.
     */
    alias: {
      "react-router-dom": "/src/shims/router.tsx",
      "@hermes/shared": "/src/shims/shared.ts",
    },
  },
  build: {
    outDir: "../../surfaces/ui/canvas",
    emptyOutDir: true,
    // One file each, named plainly. The shell serves these by path and a
    // content hash in the name buys nothing when there is no cache to bust.
    rollupOptions: {
      output: {
        entryFileNames: "canvas.js",
        chunkFileNames: "[name].js",
        assetFileNames: "[name][extname]",
      },
    },
  },
});
