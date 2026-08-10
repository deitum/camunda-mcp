import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/cli.ts', 'src/index.ts'],
      // A floor, not a target: set a little below what the suite currently
      // achieves, so that a drop is noticed but small refactors aren't blocked.
      // The tool registrations are exercised through the in-memory MCP client in
      // `server.test.ts`, but only a handful of the 25 tools are called there.
      thresholds: {
        statements: 60,
        branches: 75,
        functions: 60,
        lines: 60,
      },
    },
  },
});
