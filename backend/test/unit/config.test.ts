/**
 * Configuration tests.
 *
 * The central security property: validation failures name VARIABLE + issue
 * CODE, never a value — a broken MONGODB_URI or JWT_SECRET must not leak
 * itself through an error message or a log line.
 *
 * TIER: unit. No database.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ConfigurationError,
  loadConfig,
  loadEnvironmentFiles,
  resolveEnvFilePath,
  describeConfigForLog,
  safeMongoHost,
} from '../../src/config/env';
import { makeConfig, TEST_JWT_SECRET } from '../helpers/config';

const SECRET_PLACEHOLDER = 'super-secret-value-that-must-never-appear-Zx9';

function baseEnv(): Record<string, string> {
  return {
    NODE_ENV: 'test',
    PORT: '4100',
    MONGODB_URI: 'mongodb+srv://dbuser:dbpass@cluster.example.mongodb.net/okoa',
    JWT_SECRET: SECRET_PLACEHOLDER,
  };
}

describe('loadConfig', () => {
  it('produces a frozen config from a valid environment', () => {
    const config = loadConfig(baseEnv());
    expect(Object.isFrozen(config)).toBe(true);
    expect(config.nodeEnv).toBe('test');
    expect(config.isTest).toBe(true);
    expect(config.port).toBe(4100);
    expect(config.jwtExpiresIn).toBe('7d');
    expect(config.corsOrigin).toBeNull();
    expect(config.logLevel).toBe('info');
  });

  it('applies documented defaults for optional variables', () => {
    const config = loadConfig(baseEnv());
    expect(config.bcryptRounds).toBe(12);
    expect(config.serverSelectionTimeoutMs).toBe(5000);
    expect(config.maxRequestBodyBytes).toBe(65536);
  });

  it('rejects a missing MONGODB_URI by variable name only', () => {
    const env = baseEnv();
    delete env.MONGODB_URI;
    let thrown: unknown;
    try {
      loadConfig(env);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ConfigurationError);
    const issues = (thrown as ConfigurationError).issues;
    expect(issues.join('\n')).toContain('MONGODB_URI');
    // The error must not embed any other value either.
    expect((thrown as Error).message).not.toContain(SECRET_PLACEHOLDER);
  });

  it('rejects a MongoDB URI with a non-mongodb scheme without echoing it', () => {
    const env = baseEnv();
    env.MONGODB_URI = `https://evil.example/capture?steal=${SECRET_PLACEHOLDER}`;
    let thrown: unknown;
    try {
      loadConfig(env);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ConfigurationError);
    const issues = (thrown as ConfigurationError).issues.join('; ');
    expect(issues).toContain('MONGODB_URI');
    expect(issues).toContain('must_be_mongodb_scheme');
    // Crucially: the offending VALUE is absent from the message.
    expect((thrown as Error).message).not.toContain('evil.example');
    expect((thrown as Error).message).not.toContain(SECRET_PLACEHOLDER);
  });

  it('rejects a JWT secret shorter than 32 characters without echoing it', () => {
    const env = baseEnv();
    env.JWT_SECRET = 'short-secret';
    let thrown: unknown;
    try {
      loadConfig(env);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ConfigurationError);
    const issues = (thrown as ConfigurationError).issues.join('; ');
    expect(issues).toContain('JWT_SECRET');
    expect(issues).toContain('must_be_at_least_32_characters');
    expect((thrown as Error).message).not.toContain('short-secret');
  });

  it('rejects an out-of-range PORT by variable name', () => {
    const env = baseEnv();
    env.PORT = '70000';
    expect(() => loadConfig(env)).toThrow(ConfigurationError);
    try {
      loadConfig(env);
    } catch (error) {
      expect((error as ConfigurationError).issues.join('; ')).toContain('PORT');
    }
  });

  it('reports multiple issues in one pass', () => {
    const env = { NODE_ENV: 'test' };
    try {
      loadConfig(env);
      expect.unreachable('expected ConfigurationError');
    } catch (error) {
      const issues = (error as ConfigurationError).issues.join('; ');
      expect(issues).toContain('MONGODB_URI');
      expect(issues).toContain('JWT_SECRET');
    }
  });
});

describe('describeConfigForLog', () => {
  it('never contains the URI or the JWT secret', () => {
    const config = loadConfig(baseEnv());
    const view = describeConfigForLog(config);
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain(config.mongodbUri);
    expect(serialized).not.toContain(config.jwtSecret);
    expect(serialized).not.toContain(SECRET_PLACEHOLDER);
    expect(serialized).not.toContain('dbpass');
    expect(Object.keys(view)).not.toContain('mongodbUri');
    expect(Object.keys(view)).not.toContain('jwtSecret');
  });

  it('keeps only host and database name for diagnostics', () => {
    const config = loadConfig(baseEnv());
    const view = describeConfigForLog(config);
    expect(view.mongodbHost).toBe('cluster.example.mongodb.net');
  });
});

describe('safeMongoHost', () => {
  it('extracts the host without credentials', () => {
    expect(safeMongoHost('mongodb+srv://user:pass@cluster.example.mongodb.net/db')).toBe(
      'cluster.example.mongodb.net',
    );
    expect(safeMongoHost('mongodb://user:pass@localhost:27017/db')).toBe('localhost:27017');
  });

  it('returns null for unrecognised input instead of partial credentials', () => {
    expect(safeMongoHost('not a uri')).toBeNull();
    expect(safeMongoHost('https://user:pass@example.com/')).toBeNull();
    expect(safeMongoHost('mongodb+srv://nohost-but-user:pass')).toBeNull();
  });
});

describe('repository-root .env loading', () => {
  const createdDirs: string[] = [];

  afterEach(() => {
    for (const dir of createdDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
    delete process.env.OA_TEST_FROM_FILE;
    delete process.env.OA_TEST_PRESERVED;
  });

  it('resolves the .env path from an explicit root, not the cwd', () => {
    const root = '/tmp/example-root';
    expect(resolveEnvFilePath(root)).toBe(path.join(root, '.env'));
  });

  it('loads a .env from the explicit root when present', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'oa-env-'));
    createdDirs.push(dir);
    writeFileSync(path.join(dir, '.env'), 'OA_TEST_FROM_FILE=loaded\n', 'utf8');
    const result = loadEnvironmentFiles(dir);
    expect(result.loaded).toBe(true);
    expect(result.path).toBe(path.join(dir, '.env'));
    expect(process.env.OA_TEST_FROM_FILE).toBe('loaded');
  });

  it('does not overwrite an existing environment variable (override: false)', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'oa-env-'));
    createdDirs.push(dir);
    writeFileSync(path.join(dir, '.env'), 'OA_TEST_PRESERVED=from-file\n', 'utf8');
    process.env.OA_TEST_PRESERVED = 'from-shell';
    loadEnvironmentFiles(dir);
    expect(process.env.OA_TEST_PRESERVED).toBe('from-shell');
  });

  it('reports loaded:false when no .env exists rather than failing', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'oa-env-'));
    createdDirs.push(dir);
    const result = loadEnvironmentFiles(dir);
    expect(result.loaded).toBe(false);
    expect(result.path).toBe(path.join(dir, '.env'));
  });
});

describe('config fixture used by other suites', () => {
  it('is valid per the real schema except for the local-only URI style', () => {
    const fixture = makeConfig();
    expect(fixture.jwtSecret.length).toBeGreaterThanOrEqual(32);
    expect(fixture.jwtSecret).toBe(TEST_JWT_SECRET);
    expect(fixture.isTest).toBe(true);
  });
});