import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    // Integration tests start nested containers and run production-style CLI
    // upgrades. CI shards them across runners; keep every shard serial.
    fileParallelism: false,
    projects: [
      {
        plugins: [tsconfigPaths()],
        test: {
          name: 'unit',
          include: ['packages/**/test/**/*.test.ts', 'tests/unit/**/*.test.ts', 'tests/architecture/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        plugins: [tsconfigPaths()],
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          environment: 'node',
          globalSetup: ['tests/integration/global-setup.ts'],
          testTimeout: 180_000,
          hookTimeout: 300_000,
        },
      },
      {
        plugins: [tsconfigPaths()],
        test: {
          name: 'admin',
          include: ['apps/admin/**/*.test.ts', 'apps/admin/**/*.test.tsx'],
          environment: 'jsdom',
          setupFiles: ['apps/admin/vitest.setup.ts'],
        },
      },
    ],
  },
});
