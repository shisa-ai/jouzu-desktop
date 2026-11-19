import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
export default defineConfig({
  resolve: { alias: { "@": new URL("./src", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1") } },
  plugins: [react(), tailwindcss()],
  // The webview and a browser may resolve localhost to different address families, so the dev server
  // answers on both.
  server: { port: 1420, strictPort: true, host: '::' },
  clearScreen: false,
});
