/**
 * MongoDB implementation of `AlertRepository`.
 *
 * Idempotency relies on the unique index over `alerts.id`, not on an
 * application-level check-then-write: two concurrent syncs of the same alert
 * race, and only the database can settle that reliably.
 */

import mongoose from 'mongoose';
import { Alert } from '../models';
import {
  isLocationUnavailableReason,
  type AlertCategory,
  type AlertLocation,
  type IngestionStatus,
} from '../domain/alerts';
import type {
  AlertCandidate,
  AlertRepository,
  IngestOutcome,
  ListAlertsOptions,
  StoredAlert,
} from './alert-repository';

const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 500;

/** MongoDB duplicate-key error code. */
const DUPLICATE_KEY_CODE = 11000;

export function isDuplicateKeyError(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; message?: unknown };
  if (candidate.code === DUPLICATE_KEY_CODE) return true;
  // Driver/server versions differ in how the code surfaces; fall back to the
  // canonical marker rather than treating a duplicate as an unknown failure.
  return typeof candidate.message === 'string' && candidate.message.includes('E11000');
}

type AlertShape = Readonly<{
  id: string;
  category: string;
  location: {
    state: string;
    latitude: number | null;
    longitude: number | null;
    accuracyMeters: number | null;
    reason: string | null;
  };
  createdAtUtc: string;
  receivedAtUtc: string;
  ingestionStatus: string;
  serverReceipt: string;
  receivedBy: mongoose.Types.ObjectId | null;
}>;

/** Defensive mapping: a malformed document must not silently become an alert. */
function toStoredAlert(document: AlertShape): StoredAlert {
  const location: AlertLocation =
    document.location.state === 'available' &&
    typeof document.location.latitude === 'number' &&
    typeof document.location.longitude === 'number'
      ? {
          state: 'available',
          latitude: document.location.latitude,
          longitude: document.location.longitude,
          accuracyMeters:
            typeof document.location.accuracyMeters === 'number'
              ? document.location.accuracyMeters
              : null,
        }
      : {
          state: 'unavailable',
          reason: isLocationUnavailableReason(document.location.reason)
            ? document.location.reason
            : 'unknown',
        };

  return Object.freeze({
    id: document.id,
    category: document.category as AlertCategory,
    location,
    createdAtUtc: document.createdAtUtc,
    receivedAtUtc: document.receivedAtUtc,
    ingestionStatus: document.ingestionStatus as IngestionStatus,
    serverReceipt: document.serverReceipt,
    receivedBy: document.receivedBy ? String(document.receivedBy) : null,
  });
}

export class MongoAlertRepository implements AlertRepository {
  async ingest(candidate: AlertCandidate, receivedBy: string | null): Promise<IngestOutcome> {
    const receivedAtUtc = new Date().toISOString();
    // The receipt is generated here, but it is only ever RETURNED when the
    // document is provably in the database (either we wrote it, or we read
    // the existing one back).
    const provisionalReceipt = `rcpt_${Date.now().toString(36)}_${Math.random()
      .toString(36)
      .slice(2, 12)}`;

    try {
      await Alert.create({
        id: candidate.id,
        category: candidate.category,
        location: toDocumentLocation(candidate.location),
        createdAtUtc: candidate.createdAtUtc,
        receivedAtUtc,
        ingestionStatus: 'received',
        serverReceipt: provisionalReceipt,
        receivedBy: receivedBy && mongoose.isValidObjectId(receivedBy) ? receivedBy : null,
      });

      return Object.freeze({ kind: 'created', receipt: provisionalReceipt, receivedAtUtc });
    } catch (error) {
      if (!isDuplicateKeyError(error)) {
        throw error;
      }
    }

    // Duplicate key: the alert was already ingested. A receipt is only
    // returned if this lookup actually returns the stored document.
    let existing: AlertShape | null;
    try {
      existing = (await Alert.findOne({ id: candidate.id })
        .lean()
        .exec()) as AlertShape | null;
    } catch {
      // Lookup failed. We know a document exists (the index said so) but we
      // cannot show its receipt, so the client must retry.
      return Object.freeze({ kind: 'unconfirmed' });
    }

    if (
      !existing ||
      typeof existing.serverReceipt !== 'string' ||
      existing.serverReceipt.trim().length === 0
    ) {
      return Object.freeze({ kind: 'unconfirmed' });
    }

    return Object.freeze({
      kind: 'duplicate',
      receipt: existing.serverReceipt,
      receivedAtUtc: existing.receivedAtUtc,
    });
  }

  async findById(id: string): Promise<StoredAlert | null> {
    const document = (await Alert.findOne({ id }).lean().exec()) as AlertShape | null;
    return document ? toStoredAlert(document) : null;
  }

  async list(options: ListAlertsOptions = {}): Promise<readonly StoredAlert[]> {
    const limit = Math.min(Math.max(options.limit ?? DEFAULT_LIST_LIMIT, 1), MAX_LIST_LIMIT);
    const filter: Record<string, unknown> = {};
    if (options.category) filter.category = options.category;

    const documents = (await Alert.find(filter)
      .sort({ receivedAtUtc: -1, id: -1 })
      .limit(limit)
      .lean()
      .exec()) as AlertShape[];

    return documents.map(toStoredAlert);
  }

  async deleteById(id: string): Promise<boolean> {
    const result = await Alert.deleteOne({ id }).exec();
    return (result.deletedCount ?? 0) === 1;
  }
}

function toDocumentLocation(location: AlertLocation): Record<string, unknown> {
  if (location.state === 'available') {
    return {
      state: 'available',
      latitude: location.latitude,
      longitude: location.longitude,
      accuracyMeters: location.accuracyMeters,
      reason: null,
    };
  }
  return {
    state: 'unavailable',
    latitude: null,
    longitude: null,
    accuracyMeters: null,
    reason: location.reason,
  };
}
