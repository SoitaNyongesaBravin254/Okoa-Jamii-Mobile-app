/**
 * MongoDB documents.
 *
 * Mongoose is configured to be strict and to reject unknown fields, matching
 * the `.strict()` Zod schemas at the HTTP boundary — a field that is not
 * declared here cannot be persisted.
 */

import mongoose from 'mongoose';
import { ALERT_CATEGORIES, INGESTION_STATUSES, LOCATION_UNAVAILABLE_REASONS } from '../domain/alerts';
import { USER_ROLES } from '../domain/auth';

const { Schema, model } = mongoose;

export type UserDocument = mongoose.HydratedDocument<{
  email: string;
  displayName: string;
  passwordHash: string;
  role: string;
  createdAtUtc: string;
  updatedAtUtc: string;
}>;

const userSchema = new Schema(
  {
    email: { type: String, required: true, unique: true, index: true },
    displayName: { type: String, required: true },
    // bcrypt hash. Never returned by any query used by an HTTP response.
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, enum: [...USER_ROLES], required: true, default: 'community' },
    createdAtUtc: { type: String, required: true },
    updatedAtUtc: { type: String, required: true },
  },
  {
    strict: true,
    versionKey: false,
  },
);

export const User = model('User', userSchema, 'users');

export type AlertDocumentShape = Readonly<{
  /** Client-generated id — the idempotency key. */
  id: string;
  category: string;
  location:
    | { state: 'available'; latitude: number; longitude: number; accuracyMeters: number | null }
    | { state: 'unavailable'; reason: string };
  createdAtUtc: string;
  receivedAtUtc: string;
  ingestionStatus: string;
  serverReceipt: string;
  receivedBy: mongoose.Types.ObjectId | null;
}>;

const alertSchema = new Schema(
  {
    // Unique index => the database, not application code, is the arbiter of
    // "have I already ingested this alert?".
    id: { type: String, required: true, unique: true, index: true },
    category: { type: String, enum: [...ALERT_CATEGORIES], required: true },
    location: {
      _id: false,
      type: new Schema(
        {
          state: {
            type: String,
            enum: ['available', 'unavailable'],
            required: true,
          },
          latitude: { type: Number, default: null },
          longitude: { type: Number, default: null },
          accuracyMeters: { type: Number, default: null },
          reason: { type: String, enum: [...LOCATION_UNAVAILABLE_REASONS, null], default: null },
        },
        { strict: true, _id: false },
      ),
      required: true,
    },
    createdAtUtc: { type: String, required: true },
    receivedAtUtc: { type: String, required: true },
    ingestionStatus: { type: String, enum: [...INGESTION_STATUSES], required: true },
    serverReceipt: { type: String, required: true, unique: true, index: true },
    receivedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  {
    strict: true,
    versionKey: false,
  },
);

// Supports the responder dashboard's "newest first" listing.
alertSchema.index({ receivedAtUtc: -1 });

export const Alert = model('Alert', alertSchema, 'alerts');
