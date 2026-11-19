import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  // The same "@" as the app build, so components render in tests as they do in the app.
  resolve: { alias: { "@": new URL("./src", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1") } },
  test: { include: ['src/**/*.test.ts', 'src/**/*.test.tsx'] },
});
