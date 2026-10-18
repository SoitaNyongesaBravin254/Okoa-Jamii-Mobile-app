import { defineConfig } from 'vitest/config';

/**
 * Test suites are deliberately split so the database dependency is explicit:
 *
 *  - test/unit        -> NO database at all. Pure logic plus in-memory fakes.
 *  - test/integration -> ISOLATED test database (never the real Atlas cluster).
 *                        Requires TEST_MONGODB_URI; skipped when absent.
 *  - test/atlas       -> REAL Atlas cluster. Requires RUN_ATLAS_TESTS=1 and
 *                        MONGODB_URI; skipped when absent.
 *
 * The default `npm test` runs every suite; the two database tiers self-skip
 * when their environment variables are missing, so a bare checkout is green.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Database tiers open real sockets; give them room but do not hang forever.
    testTimeout: 30_000,
    hookTimeout: 60_000,
    reporters: ['default'],
  },
});
