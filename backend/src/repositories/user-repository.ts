/**
 * User repository contract and MongoDB implementation.
 *
 * `passwordHash` is part of the stored shape on purpose: the auth service
 * needs it to verify a login. The rule is that it is converted to a
 * `UserProfile` before it can reach a response, and no other layer sees it.
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
  create(user: NewUser): Promise<StoredUser>;
}

type UserShape = Readonly<{
  _id: unknown;
  email: string;
  displayName: string;
  passwordHash: string;
  role: string;
}>;

function toStoredUser(document: UserShape): StoredUser {
  return Object.freeze({
    id: String(document._id),
    email: document.email,
    displayName: document.displayName,
    passwordHash: document.passwordHash,
    role: isUserRole(document.role) ? document.role : 'community',
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
    const document = (await User.findById(id)
      .select('+passwordHash')
      .lean()
      .exec()) as UserShape | null;
    return document ? toStoredUser(document) : null;
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
