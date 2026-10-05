import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test',
  testMatch: '**/*.pw.ts',
  // Las pruebas contra Abaya real (@abaya) solo corren con ABAYA_E2E=1.
  grepInvert: process.env.ABAYA_E2E === '1' ? undefined : /@abaya/,
  fullyParallel: true,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    headless: true,
    // Trazas solo en error (sección 8); se guardan fuera del repo versionado.
    trace: 'retain-on-failure',
  },
  outputDir: './test-results',
});
