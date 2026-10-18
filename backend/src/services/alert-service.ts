/**
 * Alert ingestion service.
 *
 * This is where the receipt invariant lives:
 *
 *   A server receipt is returned ONLY after (a) the document was successfully
 *   written, or (b) a duplicate lookup actually read back the stored document.
 *
 * Note that the receipt the service generates for a candidate is treated as
 * provisional until the repository confirms the write. If the repository
 * reports `unconfirmed`, the provisional receipt is discarded — it is never
 * echoed back to the client.
 */

import { z } from 'zod';
import { sanitizeMessage } from '../config/redact';
import type { Logger } from '../lib/logger';
import { ServiceUnavailableError, ValidationError } from '../lib/errors';
import { ingestAlertInputSchema, type AlertCandidate, type AlertCategory } from '../domain/alerts';
import type { AlertRepository, ListAlertsOptions, StoredAlert } from '../repositories/alert-repository';

export type AlertIngestionResult = Readonly<{
  ok: true;
  alert: Readonly<{
    id: string;
    category: AlertCategory;
    status: 'received';
    serverReceipt: string;
    createdAtUtc: string;
    receivedAtUtc: string;
    /** True when this alert had already been ingested; no duplicate was written. */
    duplicate: boolean;
  }>;
}>;

export type AlertService = Readonly<{
  ingestAlert(receivedBy: string | null, payload: unknown): Promise<AlertIngestionResult>;
  listAlerts(options?: ListAlertsOptions): Promise<readonly StoredAlert[]>;
  getAlert(id: string): Promise<StoredAlert | null>;
  deleteAlert(id: string): Promise<boolean>;
}>;

/** Maps Zod issues to client-safe strings; values are never echoed. */
function toIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const field = issue.path.length > 0 ? issue.path.join('.') : 'payload';
    // Custom tags (control_characters, not_canonical_utc, ...) are static
    // strings authored in our schemas — stable reasons that echo no value.
    if (issue.code === 'custom') return `${field}: ${sanitizeMessage(issue.message)}`;
    return `${field}: ${issue.code}`;
  });
}

export function createAlertService(deps: {
  alerts: AlertRepository;
  logger: Logger;
}): AlertService {
  const { alerts, logger } = deps;

  return Object.freeze({
    async ingestAlert(receivedBy, payload): Promise<AlertIngestionResult> {
      const parsed = ingestAlertInputSchema.safeParse(payload);
      if (!parsed.success) {
        // Rejections are client-fixable. Log the field names only.
        logger.warn('alert rejected by validation', { issues: toIssues(parsed.error) });
        throw new ValidationError('The alert payload is invalid.', toIssues(parsed.error));
      }

      const input = parsed.data;
      const candidate: AlertCandidate = Object.freeze({
        id: input.id,
        category: input.category,
        location: input.location,
        // The client may backdate an offline alert; otherwise receipt time.
        createdAtUtc: input.createdAtUtc ?? new Date().toISOString(),
      });

      let outcome;
      try {
        outcome = await alerts.ingest(candidate, receivedBy);
      } catch (error) {
        // Storage failure: the client must retry. Nothing about the payload
        // or the driver error is returned.
        logger.error('alert ingestion failed', {
          alertId: candidate.id,
          errorName: error instanceof Error ? error.name : 'unknown',
        });
        throw new ServiceUnavailableError(
          'The alert could not be recorded. Please try again.',
        );
      }

      if (outcome.kind === 'unconfirmed') {
        logger.error('alert ingestion unconfirmed', { alertId: candidate.id });
        throw new ServiceUnavailableError(
          'The alert could not be confirmed. Please retry the sync.',
        );
      }

      const duplicate = outcome.kind === 'duplicate';
      logger.info(duplicate ? 'alert duplicate ignored' : 'alert ingested', {
        alertId: candidate.id,
        category: candidate.category,
        duplicate,
      });

      return Object.freeze({
        ok: true as const,
        alert: Object.freeze({
          id: candidate.id,
          category: candidate.category,
          status: 'received' as const,
          serverReceipt: outcome.receipt,
          createdAtUtc: candidate.createdAtUtc,
          receivedAtUtc: outcome.receivedAtUtc,
          duplicate,
        }),
      });
    },

    listAlerts(options) {
      return alerts.list(options);
    },

    getAlert(id) {
      return alerts.findById(id);
    },

    deleteAlert(id) {
      return alerts.deleteById(id);
    },
  });
}
