import { defineConfig } from '@playwright/test';

// Browser tests live in e2e/: the default pattern would also collect the vitest files under src/.
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
});
