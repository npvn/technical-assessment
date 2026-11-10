import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Vitest config for mutation testing only (npm run test:mutation).
// It runs the scheduling unit tests and nothing else, so no global setup is
// loaded and no Postgres container starts. It lives under test/ so the
// tsconfig covers it and typed lint can check it.
export default defineConfig({
  test: {
    // The repo root, two folders up. Stryker copies the repo into a sandbox,
    // so this points at the sandbox copy when it runs there.
    root: fileURLToPath(new URL('../../', import.meta.url)),
    globals: true,
    include: ['test/unit/scheduling/**/*.test.ts'],
  },
});
