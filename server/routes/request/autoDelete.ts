import { Router } from 'express';
import { getRepository } from '@server/datasource';
import { MediaRequest } from '@server/entity/MediaRequest';
import { Permission } from '@server/lib/permissions';
import { isAuthenticated } from '@server/middleware/auth';
import logger from '@server/logger';

const autoDeleteRoutes = Router();

/**
 * POST /api/v1/request/auto-delete/:requestId
 * Set auto-delete expiration for a request
 * 
 * Body: { days: number }  // Days until auto-delete (0 or null = remove expiration)
 */
autoDeleteRoutes.post(
  '/auto-delete/:requestId',
  isAuthenticated(Permission.MANAGE_REQUESTS),
  async (req, res, next) => {
    const requestRepository = getRepository(MediaRequest);

    try {
      const request = await requestRepository.findOneOrFail({
        where: { id: Number(req.params.requestId) },
      });

      const days = Number(req.body.days);

      if (days > 0) {
        const autoDeleteDate = new Date();
        autoDeleteDate.setDate(autoDeleteDate.getDate() + days);
        request.autoDeleteDate = autoDeleteDate;

        logger.info('Auto-delete expiration set for request', {
          label: 'Auto-Delete API',
          requestId: request.id,
          days,
          autoDeleteDate: autoDeleteDate.toISOString(),
        });
      } else {
        request.autoDeleteDate = null as any;

        logger.info('Auto-delete expiration removed from request', {
          label: 'Auto-Delete API',
          requestId: request.id,
        });
      }

      await requestRepository.save(request);

      return res.status(200).json(request);
    } catch (e) {
      logger.error('Error setting auto-delete', {
        label: 'Auto-Delete API',
        error: e.message,
      });
      next({ status: 404, message: 'Request not found.' });
    }
  }
);

/**
 * GET /api/v1/request/auto-delete/:requestId
 * Get auto-delete info for a request
 */
autoDeleteRoutes.get(
  '/auto-delete/:requestId',
  isAuthenticated(Permission.MANAGE_REQUESTS),
  async (req, res, next) => {
    const requestRepository = getRepository(MediaRequest);

    try {
      const request = await requestRepository.findOneOrFail({
        where: { id: Number(req.params.requestId) },
        select: ['id', 'autoDeleteDate'],
      });

      return res.status(200).json({
        requestId: request.id,
        autoDeleteDate: request.autoDeleteDate,
        hasExpiration: !!request.autoDeleteDate,
        daysUntilDeletion: request.autoDeleteDate
          ? Math.ceil(
              (request.autoDeleteDate.getTime() - Date.now()) / 1000 / 60 / 60 / 24
            )
          : null,
      });
    } catch (e) {
      next({ status: 404, message: 'Request not found.' });
    }
  }
);

export default autoDeleteRoutes;

