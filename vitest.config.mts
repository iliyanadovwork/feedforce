import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Unit tests run in the Node environment (the code under test uses node:dns/promises etc.).
// Test files live next to the code as *.test.ts. This config does NOT affect `next build`
// (webpack only bundles imported modules; test files are never imported by the app).
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
