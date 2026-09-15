import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Keeps the dev origin identical to production's same-origin setup, so
    // cookie and CORS behaviour does not differ between the two.
    proxy: {
      "/api": {
        target: process.env["VITE_API_URL"] ?? "http://localhost:4000",
        changeOrigin: true,
      },
    },
  },
});
