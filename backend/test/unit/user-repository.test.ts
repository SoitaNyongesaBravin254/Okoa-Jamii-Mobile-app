/**
 * MongoUserRepository query shape + stored-record integrity tests.
 *
 * The Mongoose `User` model is mocked, so this stays in the unit tier (no
 * database) while still asserting WHAT THE REPOSITORY ASKS MONGODB FOR:
 *  - a profile read (/auth/me) never opts into `passwordHash`;
 *  - a login read still opts in, so password verification is unaffected;
 *  - a persisted role outside USER_ROLES is refused instead of being
 *    silently coerced to `community`.
 *
 * The mock reproduces the only Mongoose behaviour that matters here:
 * `passwordHash` carries `select: false` and is only returned when a query
 * explicitly opts in with `.select('+passwordHash')`.
 *
 * TIER: unit. No database.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const modelState = vi.hoisted(() => ({
  /** Every `.select(...)` argument the repository asked for, in order. */
  selectCalls: [] as string[],
  /** Queries actually executed against the model. */
  execCount: 0,
  /** The stored document, before projection is applied by `exec()`. */
  document: null as Record<string, unknown> | null,
}));

vi.mock('../../src/models', () => {
  /** Mirrors `select: false` + `.select('+passwordHash')` opt-in semantics. */
  function makeQuery() {
    const selects: string[] = [];
    const query = {
      select(arg: string) {
        selects.push(arg);
        modelState.selectCalls.push(arg);
        return query;
      },
      lean() {
        return query;
      },
      async exec() {
        modelState.execCount += 1;
        const document = modelState.document;
        if (!document) return null;
        const optedIn = selects.some((arg) => arg.includes('+passwordHash'));
        if (optedIn || !('passwordHash' in document)) return { ...document };
        const { passwordHash: _omitted, ...projected } = document;
        return projected;
      },
    };
    return query;
  }

  return {
    User: {
      findById: () => makeQuery(),
      findOne: () => makeQuery(),
    },
  };
});

import { MongoUserRepository, toStoredUser } from '../../src/repositories/user-repository';

/** A real-shaped account id: the repository rejects anything else. */
const ACCOUNT_ID = '507f1f77bcf86cd799439011';

const STORED_DOCUMENT = {
  _id: ACCOUNT_ID,
  email: 'amina@example.com',
  displayName: 'Amina Juma',
  passwordHash: '$2b$10$fixturehashfixturehashfixturehashfixturehashfixturehash',
  role: 'community',
};

describe('MongoUserRepository query shape (mocked model)', () => {
  beforeEach(() => {
    modelState.selectCalls = [];
    modelState.execCount = 0;
    modelState.document = { ...STORED_DOCUMENT };
  });

  it('findProfileById never opts into the password hash', async () => {
    const users = new MongoUserRepository();
    const profile = await users.findProfileById(ACCOUNT_ID);

    expect(modelState.selectCalls).not.toContain('+passwordHash');
    expect(profile).toEqual({
      id: ACCOUNT_ID,
      email: 'amina@example.com',
      displayName: 'Amina Juma',
      role: 'community',
    });
    expect(profile).not.toHaveProperty('passwordHash');
  });

  it('findProfileById returns null for an unknown id', async () => {
    modelState.document = null;
    const users = new MongoUserRepository();
    expect(await users.findProfileById('000000000000000000000000')).toBeNull();
  });

  it('treats a malformed account id as missing instead of letting Mongoose throw', async () => {
    const users = new MongoUserRepository();
    for (const id of ['u-123', '', 'not-an-object-id', '507f1f77bcf86cd79943901']) {
      // A bad token `sub` must be an authentication failure (null -> 401),
      // never a CastError that surfaces as a 500.
      expect(await users.findProfileById(id), id).toBeNull();
      expect(await users.findById(id), id).toBeNull();
    }
    // Guarded before the query is built: Mongoose is never asked.
    expect(modelState.execCount).toBe(0);
  });

  it('findByEmail still opts in, so login can verify the password', async () => {
    const users = new MongoUserRepository();
    const user = await users.findByEmail('  AMINA@Example.com ');

    expect(modelState.selectCalls).toContain('+passwordHash');
    expect(user?.passwordHash).toBe(STORED_DOCUMENT.passwordHash);
  });

  it('findById keeps its hash-bearing contract for existing callers', async () => {
    const users = new MongoUserRepository();
    const user = await users.findById(ACCOUNT_ID);

    expect(modelState.selectCalls).toContain('+passwordHash');
    expect(user?.passwordHash).toBe(STORED_DOCUMENT.passwordHash);
  });
});

describe('persisted role integrity on every read path', () => {
  beforeEach(() => {
    modelState.selectCalls = [];
    modelState.execCount = 0;
    modelState.document = { ...STORED_DOCUMENT };
  });

  it('refuses an unknown role on the profile read instead of downgrading it', async () => {
    modelState.document = { ...STORED_DOCUMENT, role: 'superuser' };
    const users = new MongoUserRepository();

    // Rejecting is the guarantee: no profile is built, so /auth/me and every
    // authorization lookup fail closed rather than using a coerced role.
    await expect(users.findProfileById(ACCOUNT_ID)).rejects.toThrow(/role integrity/);
  });

  it('refuses an unknown role on the login read, so no session is issued', async () => {
    modelState.document = { ...STORED_DOCUMENT, role: 'ADMIN' };
    const users = new MongoUserRepository();

    await expect(users.findByEmail('amina@example.com')).rejects.toThrow(/role integrity/);
  });
});

describe('toStoredUser role integrity', () => {
  const base = {
    _id: 'u-9',
    email: 'x@example.com',
    displayName: 'X Y',
    passwordHash: '$2b$10$fixturehashfixturehashfixturehashfixturehashfixturehash',
    role: 'community',
  };

  it('passes every known role through unchanged', () => {
    for (const role of ['community', 'responder', 'admin'] as const) {
      expect(toStoredUser({ ...base, role }).role).toBe(role);
    }
  });

  it('refuses an unknown persisted role instead of coercing it to community', () => {
    for (const role of ['superuser', '', 'ADMIN', 'admin ', '1']) {
      expect(() => toStoredUser({ ...base, role }), role).toThrow(/role integrity/);
    }
  });

  it('reports the anomaly without echoing the invalid stored value', () => {
    let message = '';
    try {
      toStoredUser({ ...base, role: 'attacker-controlled-role-string' });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('u-9');
    expect(message).not.toContain('attacker-controlled-role-string');
  });
});