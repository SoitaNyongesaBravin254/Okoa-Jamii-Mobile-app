/**
 * Safe-logging tests.
 *
 * These assert the redaction layer itself: connection strings, JWTs and
 * bearer tokens must not survive any path that can reach a log sink or an
 * error payload.
 *
 * TIER: unit. No database.
 */

import { describe, expect, it } from 'vitest';
import {
  isSensitiveKey,
  redactSensitive,
  sanitizeMessage,
} from '../../src/config/redact';
import { createLogger, type LogRecord } from '../../src/lib/logger';

const MONGO_URI = 'mongodb+srv://admin:S3cr3tPw@cluster0.abcde.mongodb.net/okoa-jamii';
const FAKE_JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkFkbWluIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk';

describe('sanitizeMessage', () => {
  it('scrubs mongodb connection strings, including +srv and query strings', () => {
    const scrubbed = sanitizeMessage(`connect ${MONGO_URI} failed`);
    expect(scrubbed).not.toContain('cluster0.abcde.mongodb.net');
    expect(scrubbed).not.toContain('S3cr3tPw');
    expect(scrubbed).not.toContain('mongodb+srv://');
    expect(scrubbed).toContain('[redacted-mongodb-uri]');
  });

  it('scrubs JWT-shaped tokens even when embedded in prose', () => {
    const scrubbed = sanitizeMessage(`token=${FAKE_JWT}`);
    expect(scrubbed).not.toContain(FAKE_JWT);
    expect(scrubbed).toContain('[redacted-jwt]');
  });

  it('scrubs bearer credentials', () => {
    const scrubbed = sanitizeMessage('Authorization: Bearer abcdef123456');
    expect(scrubbed).not.toContain('abcdef123456');
    expect(scrubbed).toContain('Bearer [redacted]');
  });

  it('leaves ordinary messages intact', () => {
    expect(sanitizeMessage('alert ingested')).toBe('alert ingested');
  });
});

describe('isSensitiveKey', () => {
  it('flags credential-bearing key names across naming conventions', () => {
    for (const key of [
      'password',
      'passwordHash',
      'jwtSecret',
      'accessToken',
      'refresh_token',
      'mongodbUri',
      'connection_uri',
      'dsn',
      'apiKey',
      'authorization',
      'cookie',
      'sessionToken',
      'private_key',
    ]) {
      expect(isSensitiveKey(key), key).toBe(true);
    }
  });

  it('does not flag ordinary payload fields', () => {
    for (const key of ['category', 'latitude', 'email', 'serverReceipt', 'receivedBy', 'role']) {
      expect(isSensitiveKey(key), key).toBe(false);
    }
  });
});

describe('redactSensitive', () => {
  it('redacts sensitive keys deeply while keeping structure', () => {
    const result = redactSensitive({
      mongodbUri: MONGO_URI,
      nested: { passwordHash: '$2b$12$abcdef', label: 'ok' },
      items: [{ apiKey: 'k-123' }, { category: 'fire' }],
    }) as Record<string, any>;

    expect(result.mongodbUri).toBe('[redacted]');
    expect(result.nested.passwordHash).toBe('[redacted]');
    expect(result.nested.label).toBe('ok');
    expect(result.items[0].apiKey).toBe('[redacted]');
    expect(result.items[1].category).toBe('fire');
  });

  it('scrubs secrets hiding inside string values of innocent keys', () => {
    const result = redactSensitive({ detail: `failed: ${MONGO_URI}` }) as Record<string, string>;
    expect(result.detail).not.toContain('S3cr3tPw');
    expect(result.detail).not.toContain('cluster0.abcde.mongodb.net');
  });

  it('scrubs error messages and stacks', () => {
    const error = new Error(`driver blew up on ${MONGO_URI}`);
    const result = redactSensitive(error) as { message: string; stack?: string };
    expect(result.message).not.toContain('S3cr3tPw');
    if (result.stack) expect(result.stack).not.toContain('S3cr3tPw');
  });

  it('survives circular structures', () => {
    const node: Record<string, unknown> = { label: 'a' };
    node.self = node;
    expect(() => redactSensitive(node)).not.toThrow();
    const result = redactSensitive(node) as Record<string, unknown>;
    expect(result.self).toBe('[circular]');
  });
});

describe('createLogger', () => {
  function capture(): { records: LogRecord[]; logger: ReturnType<typeof createLogger> } {
    const records: LogRecord[] = [];
    const logger = createLogger({ level: 'debug', sink: (record) => records.push(record) });
    return { records, logger };
  }

  it('never lets a secret reach the sink through the message', () => {
    const { records, logger } = capture();
    logger.info(`connecting to ${MONGO_URI}`);
    expect(records).toHaveLength(1);
    const serialized = JSON.stringify(records[0]);
    expect(serialized).not.toContain('S3cr3tPw');
    expect(serialized).not.toContain('cluster0.abcde.mongodb.net');
    expect(serialized).not.toContain('mongodb+srv://');
  });

  it('never lets a secret reach the sink through metadata', () => {
    const { records, logger } = capture();
    logger.error('startup failed', {
      mongodbUri: MONGO_URI,
      jwtSecret: 'a-very-long-secret-value-that-is-sensitive',
      config: { JWT_SECRET: FAKE_JWT, port: 4000 },
    });
    const serialized = JSON.stringify(records[0]);
    expect(serialized).not.toContain('S3cr3tPw');
    expect(serialized).not.toContain(FAKE_JWT);
    expect(serialized).toContain('[redacted]');
    expect(serialized).toContain('"port":4000');
  });

  it('honours the level threshold', () => {
    const { records, logger } = capture();
    const warnOnly = createLogger({ level: 'warn', sink: (record) => records.push(record) });
    logger.debug('debug visible');
    warnOnly.debug('debug hidden');
    warnOnly.warn('warn visible');
    expect(records.map((record) => record.level)).toEqual(['debug', 'warn']);
  });

  it('records valid JSON per line (structure sanity)', () => {
    const { records, logger } = capture();
    logger.info('hello', { status: 200 });
    const parsed = JSON.parse(JSON.stringify(records[0]));
    expect(parsed.level).toBe('info');
    expect(parsed.message).toBe('hello');
    expect(parsed.meta.status).toBe(200);
    expect(typeof parsed.time).toBe('string');
  });
});