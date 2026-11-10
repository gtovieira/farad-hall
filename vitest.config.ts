// One vitest run for the whole repository: the Node packages and the API (real Postgres per file,
// packages/test-support), and the web UI in jsdom. Workspace packages resolve to their TypeScript
// sources (the "source" export condition), so tests need no build first.
import { defaultClientConditions, defaultServerConditions } from 'vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { conditions: ['source', ...defaultClientConditions] },
  ssr: { resolve: { conditions: ['source', ...defaultServerConditions], externalConditions: ['source'] } },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          environment: 'node',
          include: ['packages/*/test/**/*.test.ts', 'apps/hall-api/test/**/*.test.ts', 'tools/*/test/**/*.test.ts'],
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
      {
        extends: true,
        esbuild: { jsx: 'automatic' },
        test: {
          name: 'web',
          environment: 'jsdom',
          include: ['apps/hall-web/test/**/*.test.tsx', 'apps/hall-web/test/**/*.test.ts'],
        },
      },
    ],
  },
});
