import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// base: "./" makes the build work from any S3 prefix / website endpoint.
export default defineConfig({
  plugins: [react()],
  base: "./",
  build: {
    outDir: "dist",
    sourcemap: false,
    chunkSizeWarningLimit: 2000,
  },
});
