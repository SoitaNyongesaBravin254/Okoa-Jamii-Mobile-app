/**
 * /api/v1/alerts
 *
 *   POST   /            any authenticated role (community raises alerts)
 *   GET    /            responder | admin
 *   GET    /:id         responder | admin
 *   DELETE /:id         admin
 *
 * POST body validation happens in the alert service (the single source of
 * truth shared with tests). The response is emitted only from the service
 * result, and the service only produces a result after a confirmed database
 * write or a verified duplicate lookup.
 */

import { Router } from 'express';
import { z } from 'zod';
import { ALERT_CATEGORIES } from '../../domain/alerts';
import { AuthenticationError, NotFoundError, ValidationError } from '../../lib/errors';
import type { AlertService } from '../../services/alert-service';
import type { TokenService } from '../../services/token-service';
import { authenticate, requireAdmin, requireResponder } from '../middleware/authenticate';

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional(),
  category: z.enum(ALERT_CATEGORIES).optional(),
});

function queryIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const field = issue.path.length > 0 ? issue.path.join('.') : 'query';
    return `${field}: ${issue.code}`;
  });
}

/** `:id` path parameter, defensively narrowed to a string. */
function pathId(value: string | string[] | undefined): string {
  return typeof value === 'string' ? value : '';
}

export function createAlertRouter(deps: { alertService: AlertService; tokens: TokenService }): Router {
  const { alertService, tokens } = deps;
  const router = Router();
  const auth = authenticate(tokens);

  router.post('/', auth, async (req, res) => {
    const principal = req.principal;
    if (!principal) {
      throw new AuthenticationError('An access token is required.');
    }
    const result = await alertService.ingestAlert(principal.userId, req.body);
    // 201 for a newly persisted alert, 200 for a verified duplicate. Both
    // statuses are only reachable after the repository confirmed the write.
    res.status(result.alert.duplicate ? 200 : 201).json(result);
  });

  router.get('/', auth, requireResponder, async (req, res) => {
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new ValidationError('The query parameters are invalid.', queryIssues(parsed.error));
    }
    const alerts = await alertService.listAlerts(parsed.data);
    res.json({ alerts });
  });

  router.get('/:id', auth, requireResponder, async (req, res) => {
    const alert = await alertService.getAlert(pathId(req.params.id));
    if (!alert) {
      throw new NotFoundError('No alert matches that id.');
    }
    res.json({ alert });
  });

  router.delete('/:id', auth, requireAdmin, async (req, res) => {
    const deleted = await alertService.deleteAlert(pathId(req.params.id));
    if (!deleted) {
      throw new NotFoundError('No alert matches that id.');
    }
    res.status(204).end();
  });

  return router;
}