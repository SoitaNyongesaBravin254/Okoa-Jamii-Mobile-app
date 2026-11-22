/**
 * User repository contract and MongoDB implementation.
 *
 * `passwordHash` is part of the stored shape on purpose: the auth service
 * needs it to verify a login. The rule is that it is converted to a
 * `UserProfile` before it can reach a response, and no other layer sees it.
 *
 * Reads are split by need: `findByEmail` (login) opts into the hash, while
 * `findProfileById` (/auth/me) never asks for it — `select: false` stays in
 * force, so a profile read cannot carry the hash through memory at all.
 *
 * Id lookups are shape-checked first. A token subject that is not a persisted
 * ObjectId (a malformed or foreign `sub`) means "no such account" — returning
 * null keeps that an authentication failure instead of letting Mongoose throw
 * a CastError, which would surface as a 500.
 */

import { User } from '../models';
import { isUserRole, type UserRole } from '../domain/auth';

export type StoredUser = Readonly<{
  id: string;
  email: string;
  displayName: string;
  passwordHash: string;
  role: UserRole;
}>;

export type StoredUserProfile = Readonly<{
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
}>;

export type NewUser = Readonly<{
  email: string;
  displayName: string;
  passwordHash: string;
  role: UserRole;
}>;

export interface UserRepository {
  /** Case-insensitive: emails are normalised to lower case before storage. */
  findByEmail(email: string): Promise<StoredUser | null>;
  findById(id: string): Promise<StoredUser | null>;
  /** Profile-only read (used by /auth/me): never selects `passwordHash`. */
  findProfileById(id: string): Promise<StoredUserProfile | null>;
  create(user: NewUser): Promise<StoredUser>;
}

type UserShape = Readonly<{
  _id: unknown;
  email: string;
  displayName: string;
  passwordHash: string;
  role: string;
}>;

/** Row shape of a profile-only read: the hash is not selected at all. */
type UserProfileShape = Readonly<{
  _id: unknown;
  email: string;
  displayName: string;
  role: string;
}>;

/** The only id shape this application persists: a 24-character ObjectId. */
const ACCOUNT_ID_PATTERN = /^[0-9a-fA-F]{24}$/;

function isAccountId(id: string): boolean {
  return typeof id === 'string' && ACCOUNT_ID_PATTERN.test(id);
}

/**
 * A persisted role outside USER_ROLES is unreachable through any application
 * write (the schema enum rejects it), so it can only come from a manual edit,
 * a restore, or tampering. We fail closed instead of silently coercing to
 * `community`: no session is built from an untrusted record, and the failure
 * surfaces as a 500 in the logs. The message never echoes the stored value.
 */
function assertStoredRole(document: UserProfileShape): UserRole {
  if (!isUserRole(document.role)) {
    throw new Error(
      `stored user ${String(document._id)} failed role integrity validation; record refused`,
    );
  }
  return document.role;
}

export function toStoredUser(document: UserShape): StoredUser {
  return Object.freeze({
    id: String(document._id),
    email: document.email,
    displayName: document.displayName,
    passwordHash: document.passwordHash,
    role: assertStoredRole(document),
  });
}

/** Profile projection: no credential material exists on this type. */
function toStoredUserProfile(document: UserProfileShape): StoredUserProfile {
  return Object.freeze({
    id: String(document._id),
    email: document.email,
    displayName: document.displayName,
    role: assertStoredRole(document),
  });
}

export class MongoUserRepository implements UserRepository {
  async findByEmail(email: string): Promise<StoredUser | null> {
    // `select: false` on passwordHash means it must be opted back in.
    const document = (await User.findOne({ email: email.trim().toLowerCase() })
      .select('+passwordHash')
      .lean()
      .exec()) as UserShape | null;
    return document ? toStoredUser(document) : null;
  }

  async findById(id: string): Promise<StoredUser | null> {
    if (!isAccountId(id)) return null;
    const document = (await User.findById(id)
      .select('+passwordHash')
      .lean()
      .exec()) as UserShape | null;
    return document ? toStoredUser(document) : null;
  }

  async findProfileById(id: string): Promise<StoredUserProfile | null> {
    if (!isAccountId(id)) return null;
    // Deliberately NO `.select('+passwordHash')`: `select: false` on the
    // field keeps the hash out of the query result entirely.
    const document = (await User.findById(id).lean().exec()) as UserProfileShape | null;
    return document ? toStoredUserProfile(document) : null;
  }

  async create(user: NewUser): Promise<StoredUser> {
    const now = new Date().toISOString();
    const created = await User.create({
      email: user.email.trim().toLowerCase(),
      displayName: user.displayName,
      passwordHash: user.passwordHash,
      role: user.role,
      createdAtUtc: now,
      updatedAtUtc: now,
    });

    return Object.freeze({
      id: String(created._id),
      email: created.email,
      displayName: created.displayName,
      // Explicitly re-read rather than trusting the in-memory document shape.
      passwordHash: user.passwordHash,
      role: user.role,
    });
  }
}
