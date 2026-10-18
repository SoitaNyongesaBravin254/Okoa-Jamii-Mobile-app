/**
 * Authentication service + token service tests.
 *
 * Runs against the REAL services with an in-memory user repository — no
 * database. Covers: registration, login, account-enumeration resistance,
 * session shape (mobile `AuthSession` contract), and JWT hardening.
 *
 * TIER: unit. No database.
 */

import jwt from 'jsonwebtoken';
import { beforeEach, describe, expect, it } from 'vitest';
import { ConflictError } from '../../src/lib/errors';
import { createAuthService, type AuthService } from '../../src/services/auth-service';
import { createTokenService, type TokenService } from '../../src/services/token-service';
import type { AppConfig } from '../../src/config/env';
import { createSilentLogger } from '../../src/lib/logger';
import { InMemoryUserRepository } from '../helpers/fakes';
import type { UserRepository } from '../../src/repositories/user-repository';
import { makeConfig } from '../helpers/config';

function setup(overrides: Partial<AppConfig> = {}): {
  auth: AuthService;
  tokens: TokenService;
  users: InMemoryUserRepository;
  config: AppConfig;
} {
  const config = makeConfig(overrides);
  const users = new InMemoryUserRepository();
  const tokens = createTokenService(config);
  const auth = createAuthService({
    config,
    users,
    tokens,
    logger: createSilentLogger(),
  });
  return { auth, tokens, users, config };
}

const VALID_REGISTRATION = {
  displayName: 'Amina Juma',
  email: 'amina@example.com',
  password: 'correct-horse-battery',
};

describe('register', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it('creates an account and returns a session shaped like the mobile AuthSession', async () => {
    const outcome = await ctx.auth.register(VALID_REGISTRATION);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const { session } = outcome;
    expect(session.provider).toBe('http');
    expect(session.user).toEqual({
      id: expect.any(String),
      displayName: 'Amina Juma',
      email: 'amina@example.com',
      role: 'community',
    });
    // JWT shape: three base64url segments.
    expect(session.accessToken.split('.')).toHaveLength(3);
    // ISO-8601 expiry in the future.
    expect(Number.isNaN(Date.parse(session.expiresAt))).toBe(false);
    expect(Date.parse(session.expiresAt)).toBeGreaterThan(Date.now());
  });

  it('verifies the issued token back to the registering principal', async () => {
    const outcome = await ctx.auth.register(VALID_REGISTRATION);
    if (!outcome.ok) throw new Error('expected success');
    const principal = ctx.tokens.verify(outcome.session.accessToken);
    expect(principal.email).toBe('amina@example.com');
    expect(principal.role).toBe('community');
    expect(principal.userId).toBe(outcome.session.user.id);
  });

  it('stores a bcrypt hash, never the raw password', async () => {
    const outcome = await ctx.auth.register(VALID_REGISTRATION);
    if (!outcome.ok) throw new Error('expected success');

    const stored = await ctx.users.findByEmail('amina@example.com');
    expect(stored).not.toBeNull();
    expect(stored!.passwordHash).toMatch(/^\$2[aby]\$/);
    expect(stored!.passwordHash).not.toContain(VALID_REGISTRATION.password);

    // The raw password must not appear anywhere in the response either.
    expect(JSON.stringify(outcome)).not.toContain(VALID_REGISTRATION.password);
  });

  it('rejects duplicate registration with a conflict', async () => {
    await ctx.auth.register(VALID_REGISTRATION);
    await expect(ctx.auth.register(VALID_REGISTRATION)).rejects.toBeInstanceOf(ConflictError);
    expect(ctx.users.size).toBe(1);
  });

  it('treats a duplicate-email race (E11000 from create) as a conflict, not a 500', async () => {
    const config = makeConfig();
    const inner = new InMemoryUserRepository();
    await inner.create({
      email: VALID_REGISTRATION.email,
      displayName: 'First writer',
      passwordHash: '$2b$4$placeholder',
      role: 'community',
    });

    // The race: findByEmail misses (checked before the other writer landed)
    // but create then hits the unique index.
    const racingUsers: UserRepository = {
      findByEmail: async () => null,
      findById: (id: string) => inner.findById(id),
      create: (user) => inner.create(user),
    };
    const racing = createAuthService({
      config,
      users: racingUsers,
      tokens: createTokenService(config),
      logger: createSilentLogger(),
    });

    await expect(racing.register(VALID_REGISTRATION)).rejects.toBeInstanceOf(ConflictError);
  });

  it('rejects invalid input without creating anything', async () => {
    const cases = [
      { ...VALID_REGISTRATION, email: 'not-an-email' },
      { ...VALID_REGISTRATION, displayName: 'x' },
      { ...VALID_REGISTRATION, password: 'short' },
      { ...VALID_REGISTRATION, password: 'x'.repeat(200) },
      { ...VALID_REGISTRATION, email: `a@b${'.c'}.example .com` },
    ];
    for (const input of cases) {
      const outcome = await ctx.auth.register(input);
      expect(outcome.ok, JSON.stringify(input)).toBe(false);
      if (!outcome.ok) expect(outcome.code).toBe('invalid-input');
    }
    expect(ctx.users.size).toBe(0);
  });

  it('rejects unknown payload keys (strict schema)', async () => {
    const outcome = await ctx.auth.register({ ...VALID_REGISTRATION, role: 'admin' });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe('invalid-input');
    expect(ctx.users.size).toBe(0);
  });
});

describe('login', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(async () => {
    ctx = setup();
    const registered = await ctx.auth.register(VALID_REGISTRATION);
    if (!registered.ok) throw new Error('fixture registration failed');
  });

  it('returns a session for correct credentials', async () => {
    const outcome = await ctx.auth.login({
      email: VALID_REGISTRATION.email,
      password: VALID_REGISTRATION.password,
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.session.user.email).toBe('amina@example.com');
  });

  it('is case-insensitive on the email (normalised before storage)', async () => {
    const outcome = await ctx.auth.login({
      email: '  AMINA@Example.com ',
      password: VALID_REGISTRATION.password,
    });
    expect(outcome.ok).toBe(true);
  });

  it('returns an identical error for unknown email and wrong password (no enumeration)', async () => {
    const unknown = await ctx.auth.login({
      email: 'nobody@example.com',
      password: VALID_REGISTRATION.password,
    });
    const wrongPassword = await ctx.auth.login({
      email: VALID_REGISTRATION.email,
      password: 'definitely-wrong-password',
    });

    expect(unknown.ok).toBe(false);
    expect(wrongPassword.ok).toBe(false);
    if (unknown.ok || wrongPassword.ok) return;
    expect(unknown.code).toBe('invalid-credentials');
    expect(wrongPassword.code).toBe('invalid-credentials');
    expect(unknown.message).toBe(wrongPassword.message);
  });

  it('rejects syntactically invalid input with invalid-input, not invalid-credentials', async () => {
    const outcome = await ctx.auth.login({ email: 'nope', password: 'x' });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe('invalid-input');
  });

  it('does not leak the stored hash through the login result', async () => {
    const stored = await ctx.users.findByEmail(VALID_REGISTRATION.email);
    const outcome = await ctx.auth.login({
      email: VALID_REGISTRATION.email,
      password: VALID_REGISTRATION.password,
    });
    const serialized = JSON.stringify(outcome);
    expect(serialized).not.toContain(stored!.passwordHash);
    expect(serialized).not.toContain(VALID_REGISTRATION.password);
  });
});

describe('token service hardening', () => {
  it('rejects a token signed with a different secret', () => {
    const { config } = setup();
    const forged = jwt.sign({ role: 'admin', email: 'evil@example.com' }, 'attacker-secret-attacker-secret-attacker', {
      algorithm: 'HS256',
      subject: 'victim-id',
    });
    const tokens = createTokenService(config);
    expect(() => tokens.verify(forged)).toThrow('invalid or has expired');
  });

  it('rejects an algorithm-swapped token (pinned HS256)', () => {
    const { config } = setup();
    const tokens = createTokenService(config);
    // RS256 with a public-key-looking string: must be rejected before verify.
    let caught: unknown;
    try {
      const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
      const payload = Buffer.from(
        JSON.stringify({ sub: 'attacker', role: 'admin', email: 'a@b.co' }),
      ).toString('base64url');
      tokens.verify(`${header}.${payload}.sig`);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeDefined();
    expect((caught as Error).name).toBe('AuthenticationError');
  });

  it('rejects an expired token', async () => {
    const { config, tokens } = setup({ jwtExpiresIn: '7d' });
    const expired = jwt.sign({ role: 'admin', email: 'old@example.com' }, config.jwtSecret, {
      algorithm: 'HS256',
      subject: 'old-user',
      expiresIn: '-10s',
    });
    const fresh = createTokenService(config);
    expect(() => fresh.verify(expired)).toThrow('invalid or has expired');
    // sanity: the same service accepts a fresh token
    const issued = tokens.issue({ userId: 'u1', role: 'community', email: 'u@e.co' });
    expect(tokens.verify(issued.token).userId).toBe('u1');
  });

  it('rejects garbage and empty tokens with a uniform error', () => {
    const { tokens } = setup();
    for (const candidate of ['', '   ', 'not.a.jwt', 'a.b.c']) {
      expect(() => tokens.verify(candidate), JSON.stringify(candidate)).toThrow(
        /access token/i,
      );
    }
  });

  it('rejects a token whose role claim is not a known role', () => {
    const { config } = setup();
    const token = jwt.sign({ role: 'superuser', email: 'x@y.co' }, config.jwtSecret, {
      algorithm: 'HS256',
      subject: 'u1',
    });
    const tokens = createTokenService(config);
    expect(() => tokens.verify(token)).toThrow('invalid or has expired');
  });
});

describe('resolveUser', () => {
  it('returns the profile without the hash, and null for unknown ids', async () => {
    const ctx = setup();
    const outcome = await ctx.auth.register(VALID_REGISTRATION);
    if (!outcome.ok) throw new Error('fixture registration failed');

    const profile = await ctx.auth.resolveUser(outcome.session.user.id);
    expect(profile).toEqual({
      id: outcome.session.user.id,
      displayName: 'Amina Juma',
      email: 'amina@example.com',
      role: 'community',
    });
    expect(JSON.stringify(profile)).not.toContain('passwordHash');

    expect(await ctx.auth.resolveUser('does-not-exist')).toBeNull();
  });
});