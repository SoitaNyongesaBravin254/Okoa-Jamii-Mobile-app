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
  parseJwtExpiresIn,
  parseTrustProxy,
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

/** Runs `loadConfig` and returns the `VARIABLE: reason-code` issues, or null. */
function issuesFor(env: Record<string, string>): string[] | null {
  try {
    loadConfig(env);
    return null;
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigurationError);
    return [...(error as ConfigurationError).issues];
  }
}

describe('loadConfig', () => {
  it('produces a frozen config from a valid environment', () => {
    const config = loadConfig(baseEnv());
    expect(Object.isFrozen(config)).toBe(true);
    expect(config.nodeEnv).toBe('test');
    expect(config.isTest).toBe(true);
    expect(config.port).toBe(4100);
    expect(config.jwtExpiresIn).toBe('7d');
    expect(config.corsOrigins).toEqual([]);
    expect(config.trustProxy).toBe(false);
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

describe('JWT_EXPIRES_IN', () => {
  it('keeps the documented default of 7d', () => {
    expect(loadConfig(baseEnv()).jwtExpiresIn).toBe('7d');
  });

  it.each([
    ['60s', 60_000],
    ['1m', 60_000],
    ['15m', 900_000],
    ['1h', 3_600_000],
    ['7d', 604_800_000],
    ['4w', 2_419_200_000],
  ])('accepts %s and preserves it verbatim', (value) => {
    const env = { ...baseEnv(), JWT_EXPIRES_IN: value };
    expect(loadConfig(env).jwtExpiresIn).toBe(value);
    expect(parseJwtExpiresIn(value)).not.toBeNull();
  });

  it.each([
    '',
    '3600',
    '0',
    '0s',
    '0m',
    '1.5h',
    '7 days',
    'd',
    '-1h',
    '+1h',
    '7days',
    '1y',
  ])('rejects ambiguous or malformed %p with must_match_duration_format', (value) => {
    const issues = issuesFor({ ...baseEnv(), JWT_EXPIRES_IN: value });
    expect(issues).not.toBeNull();
    expect(issues).toContain('JWT_EXPIRES_IN: must_match_duration_format');
    // The rejected VALUE must never appear in the message.
    const message = (issues ?? []).join('; ');
    expect(message).not.toContain(SECRET_PLACEHOLDER);
  });

  it('rejects bare numeric strings rather than treating them as milliseconds', () => {
    expect(parseJwtExpiresIn('3600')).toBeNull();
    expect(issuesFor({ ...baseEnv(), JWT_EXPIRES_IN: '3600' })).toContain(
      'JWT_EXPIRES_IN: must_match_duration_format',
    );
  });

  it('rejects magnitudes that would lose precision or overflow', () => {
    // Each parses to a finite-but-huge Number (or Infinity); the bounds check
    // must still reject them rather than letting precision silently truncate.
    for (const value of ['9'.repeat(30) + 'w', '9'.repeat(400) + 'd', '9007199254740993s']) {
      expect(parseJwtExpiresIn(value)).toBeNull();
      expect(issuesFor({ ...baseEnv(), JWT_EXPIRES_IN: value })).toContain(
        'JWT_EXPIRES_IN: must_match_duration_format',
      );
    }
  });

  it('still accepts the largest legitimate boundary (30d) and just over (31d)', () => {
    expect(parseJwtExpiresIn('30d')).toBe(30 * 86_400_000);
    expect(parseJwtExpiresIn('31d')).toBeGreaterThan(30 * 86_400_000);
  });

  it('accepts the lower boundary of one minute', () => {
    expect(loadConfig({ ...baseEnv(), JWT_EXPIRES_IN: '60s' }).jwtExpiresIn).toBe('60s');
    expect(parseJwtExpiresIn('60s')).toBe(60_000);
  });

  it('rejects one second below the lower boundary', () => {
    expect(issuesFor({ ...baseEnv(), JWT_EXPIRES_IN: '59s' })).toContain(
      'JWT_EXPIRES_IN: must_be_between_1_minute_and_30_days',
    );
  });

  it('accepts the upper boundary of thirty days', () => {
    expect(loadConfig({ ...baseEnv(), JWT_EXPIRES_IN: '30d' }).jwtExpiresIn).toBe('30d');
    expect(parseJwtExpiresIn('30d')).toBe(30 * 86_400_000);
  });

  it.each(['31d', '52w', '999999999999d', '1000000h'])(
    'rejects %p as excessively large',
    (value) => {
      expect(issuesFor({ ...baseEnv(), JWT_EXPIRES_IN: value })).toContain(
        'JWT_EXPIRES_IN: must_be_between_1_minute_and_30_days',
      );
    },
  );

  it('never reports the value that was rejected', () => {
    const env = { ...baseEnv(), JWT_EXPIRES_IN: '999999999999d' };
    const issues = issuesFor(env) ?? [];
    expect(issues.join('; ')).not.toContain('999999999999');
    expect(issues.join('; ')).not.toContain(SECRET_PLACEHOLDER);
  });
});

describe('TRUST_PROXY', () => {
  it('defaults to no proxy trust (safe direct-connection behaviour)', () => {
    expect(loadConfig(baseEnv()).trustProxy).toBe(false);
    expect(loadConfig({ ...baseEnv(), TRUST_PROXY: '' }).trustProxy).toBe(false);
    expect(loadConfig({ ...baseEnv(), TRUST_PROXY: 'false' }).trustProxy).toBe(false);
    expect(loadConfig({ ...baseEnv(), TRUST_PROXY: '0' }).trustProxy).toBe(false);
  });

  it('accepts a hop count between 1 and 10', () => {
    expect(loadConfig({ ...baseEnv(), TRUST_PROXY: '1' }).trustProxy).toBe(1);
    expect(loadConfig({ ...baseEnv(), TRUST_PROXY: '10' }).trustProxy).toBe(10);
  });

  it('rejects a hop count above the ceiling', () => {
    expect(issuesFor({ ...baseEnv(), TRUST_PROXY: '11' })).toContain(
      'TRUST_PROXY: must_be_hop_count_between_1_and_10',
    );
    expect(issuesFor({ ...baseEnv(), TRUST_PROXY: '9999' })).toContain(
      'TRUST_PROXY: must_be_hop_count_between_1_and_10',
    );
  });

  it('accepts a single IP, a CIDR range and a comma-separated list of both', () => {
    expect(loadConfig({ ...baseEnv(), TRUST_PROXY: '10.0.0.0/8' }).trustProxy).toEqual([
      '10.0.0.0/8',
    ]);
    expect(loadConfig({ ...baseEnv(), TRUST_PROXY: '127.0.0.1' }).trustProxy).toEqual([
      '127.0.0.1',
    ]);
    expect(
      loadConfig({ ...baseEnv(), TRUST_PROXY: '10.0.0.0/8, 172.16.0.1' }).trustProxy,
    ).toEqual(['10.0.0.0/8', '172.16.0.1']);
    expect(loadConfig({ ...baseEnv(), TRUST_PROXY: 'fd00::/8' }).trustProxy).toEqual(['fd00::/8']);
  });

  it('rejects blind trust (true and *) so a client cannot forge its IP', () => {
    expect(issuesFor({ ...baseEnv(), TRUST_PROXY: 'true' })).toContain(
      'TRUST_PROXY: blind_trust_not_allowed',
    );
    expect(issuesFor({ ...baseEnv(), TRUST_PROXY: '*' })).toContain(
      'TRUST_PROXY: blind_trust_not_allowed',
    );
  });

  it('rejects a /0 subnet, which is blind trust in CIDR form', () => {
    // Both families, at the parser level (explicit numeric-prefix check) ...
    for (const value of ['0.0.0.0/0', '::/0']) {
      expect(parseTrustProxy(value)).toEqual({
        ok: false,
        code: 'blind_trust_not_allowed',
      });
    }
    // ... and through loadConfig, including a mixed list where only one
    // member is a /0 subnet.
    for (const value of ['0.0.0.0/0', '::/0', '10.0.0.0/8,0.0.0.0/0', 'fd00::/8,::/0']) {
      expect(issuesFor({ ...baseEnv(), TRUST_PROXY: value })).toContain(
        'TRUST_PROXY: blind_trust_not_allowed',
      );
    }
    // Non-zero prefixes of the same addresses remain valid.
    expect(parseTrustProxy('0.0.0.0/8')).toEqual({ ok: true, value: ['0.0.0.0/8'] });
    expect(parseTrustProxy('::/8')).toEqual({ ok: true, value: ['::/8'] });
  });

  it('rejects ambiguous or malformed CIDR prefixes', () => {
    for (const value of [
      '10.0.0.0/08', // leading zero (octal ambiguity)
      '10.0.0.0/00', // leading zero, and zero-width
      'fd00::/000', // zero-padded IPv6 prefix
      '10.0.0.0/033', // leading zero + out of range
      '10.0.0.1//8', // extra slash
      '10.0.0.1/8/16', // too many parts
      '/8', // missing address
      '10.0.0.256', // octet out of range
    ]) {
      expect(issuesFor({ ...baseEnv(), TRUST_PROXY: value })).toContain(
        'TRUST_PROXY: must_be_zero_hop_count_or_ip_cidr_list',
      );
    }
  });

  it('tolerates empty list entries without widening the trust set', () => {
    expect(loadConfig({ ...baseEnv(), TRUST_PROXY: '10.0.0.1,' }).trustProxy).toEqual(['10.0.0.1']);
    expect(loadConfig({ ...baseEnv(), TRUST_PROXY: ',10.0.0.1' }).trustProxy).toEqual(['10.0.0.1']);
    // An entirely empty list is the safe direct-connection default, not trust-all.
    expect(loadConfig({ ...baseEnv(), TRUST_PROXY: ',' }).trustProxy).toBe(false);
  });

  it.each(['example.com', '10.0.0.0/99', '300.1.1.1', '0x10', ' 1 , junk'])(
    'rejects %p as neither a hop count nor an IP/CIDR list',
    (value) => {
      const issues = issuesFor({ ...baseEnv(), TRUST_PROXY: value });
      expect(issues).toContain('TRUST_PROXY: must_be_zero_hop_count_or_ip_cidr_list');
      // Never echo the rejected value.
      expect((issues ?? []).join('; ')).not.toContain(value.trim());
    },
  );

  it('parseTrustProxy never yields a blind-trust setting', () => {
    for (const raw of ['true', '*', '', '3', '10.0.0.0/8']) {
      const parsed = parseTrustProxy(raw);
      expect(parsed.ok ? parsed.value : null).not.toBe(true);
    }
  });
});

describe('CORS_ORIGIN', () => {
  it('stays empty outside production so development/test behaviour is unchanged', () => {
    expect(loadConfig(baseEnv()).corsOrigins).toEqual([]);
    expect(loadConfig({ ...baseEnv(), NODE_ENV: 'development' }).corsOrigins).toEqual([]);
    expect(loadConfig({ ...baseEnv(), CORS_ORIGIN: '   ' }).corsOrigins).toEqual([]);
  });

  it('parses a single origin', () => {
    expect(loadConfig({ ...baseEnv(), CORS_ORIGIN: 'https://app.example.com' }).corsOrigins).toEqual(
      ['https://app.example.com'],
    );
  });

  it('parses multiple comma-separated origins and trims whitespace', () => {
    const env = { ...baseEnv(), CORS_ORIGIN: ' https://a.example ,http://localhost:3000 ' };
    expect(loadConfig(env).corsOrigins).toEqual(['https://a.example', 'http://localhost:3000']);
  });

  it('rejects a wildcard instead of broadening the allow-list to *', () => {
    expect(issuesFor({ ...baseEnv(), CORS_ORIGIN: '*' })).toContain(
      'CORS_ORIGIN: wildcard_not_allowed',
    );
    expect(issuesFor({ ...baseEnv(), CORS_ORIGIN: 'https://a.example, *' })).toContain(
      'CORS_ORIGIN: wildcard_not_allowed',
    );
  });

  it.each(['https://a.example/path', 'a.example', 'file://a.example', 'https://*.*', '//a.example'])(
    'rejects the non-exact origin %p',
    (value) => {
      expect(issuesFor({ ...baseEnv(), CORS_ORIGIN: value })).toContain(
        'CORS_ORIGIN: must_be_exact_http_origin',
      );
    },
  );

  it('rejects malformed hosts and non-http origins', () => {
    for (const value of [
      'https://a..b',
      'https://.example.com',
      'https://example.com.',
      'https://-bad.example',
      'ftp://a.example',
      'ws://a.example',
      'https://a b.example',
    ]) {
      expect(issuesFor({ ...baseEnv(), CORS_ORIGIN: value })).toContain(
        'CORS_ORIGIN: must_be_exact_http_origin',
      );
    }
  });

  it('rejects out-of-range ports', () => {
    for (const value of ['https://a.example:0', 'https://a.example:99999', 'https://a.example:70000']) {
      expect(issuesFor({ ...baseEnv(), CORS_ORIGIN: value })).toContain(
        'CORS_ORIGIN: port_out_of_range',
      );
    }
  });

  it('accepts valid ports at the boundaries', () => {
    for (const value of ['https://a.example:1', 'https://a.example:65535', 'http://localhost:3000']) {
      expect(loadConfig({ ...baseEnv(), CORS_ORIGIN: value }).corsOrigins).toEqual([value]);
    }
  });

  it('de-duplicates repeated origins', () => {
    const env = { ...baseEnv(), CORS_ORIGIN: 'https://a.example,https://a.example,https://b.example' };
    expect(loadConfig(env).corsOrigins).toEqual(['https://a.example', 'https://b.example']);
  });

  it('fails fast in production when the allow-list is empty', () => {
    expect(issuesFor({ ...baseEnv(), NODE_ENV: 'production' })).toContain(
      'CORS_ORIGIN: required_in_production',
    );
    expect(issuesFor({ ...baseEnv(), NODE_ENV: 'production', CORS_ORIGIN: '' })).toContain(
      'CORS_ORIGIN: required_in_production',
    );
    expect(issuesFor({ ...baseEnv(), NODE_ENV: 'production', CORS_ORIGIN: '  ' })).toContain(
      'CORS_ORIGIN: required_in_production',
    );
  });

  it('accepts production with an explicit allow-list', () => {
    const env = {
      ...baseEnv(),
      NODE_ENV: 'production',
      CORS_ORIGIN: 'https://app.example.com,https://admin.example.com',
    };
    expect(loadConfig(env).corsOrigins).toEqual([
      'https://app.example.com',
      'https://admin.example.com',
    ]);
    expect(loadConfig(env).isProduction).toBe(true);
  });

  it('does not leak the configured origins into the failure message', () => {
    const env = { ...baseEnv(), NODE_ENV: 'production', CORS_ORIGIN: 'https://secret.internal' };
    // Valid list, so loadConfig succeeds; the guard below is about INVALID input.
    expect(loadConfig(env).corsOrigins).toContain('https://secret.internal');
    const bad = { ...env, CORS_ORIGIN: 'https://secret.internal/path' };
    const issues = issuesFor(bad) ?? [];
    expect(issues.join('; ')).not.toContain('secret.internal');
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

  it('exposes only the loggable proxy and CORS view', () => {
    const config = loadConfig({ ...baseEnv(), TRUST_PROXY: '1', CORS_ORIGIN: 'https://a.example' });
    const view = describeConfigForLog(config);
    expect(view.trustProxy).toBe(1);
    expect(view.corsOrigins).toEqual(['https://a.example']);
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