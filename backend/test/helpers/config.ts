/**
 * Test configuration fixture: a complete, valid `AppConfig` that contains no
 * real credentials. `mongodbUri` deliberately points at a local database so a
 * fixture value can never be mistaken for a real cluster.
 */

import type { AppConfig } from '../../src/config/env';

export const TEST_JWT_SECRET = 'fixture-secret-not-a-real-credential-0123456789abcdef';

export function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return Object.freeze({
    nodeEnv: 'test' as const,
    isProduction: false,
    isTest: true,
    port: 4000,
    mongodbUri: 'mongodb://127.0.0.1:27017/okoa_fixture_test',
    jwtSecret: TEST_JWT_SECRET,
    jwtExpiresIn: '1h',
    corsOrigins: Object.freeze([]) as readonly string[],
    trustProxy: false as const,
    logLevel: 'error' as const,
    // Low cost: these tests hash passwords on every run.
    bcryptRounds: 4,
    serverSelectionTimeoutMs: 2_000,
    maxRequestBodyBytes: 65_536,
    ...overrides,
  });
}