import type { Request, Response, NextFunction } from 'express';
import { Router } from 'express';
import { getRepository } from '@server/datasource';
import { MediaRequest } from '@server/entity/MediaRequest';
import { Permission } from '@server/lib/permissions';
import { isAuthenticated } from '@server/middleware/auth';
import logger from '@server/logger';

const autoDeleteRoutes = Router();

autoDeleteRoutes.post(
  '/auto-delete/:requestId',
  isAuthenticated(Permission.MANAGE_REQUESTS),
  async (req: Request, res: Response, next: NextFunction) => {
    const requestRepository = getRepository(MediaRequest);

    try {
      const request = await requestRepository.findOneOrFail({
        where: { id: Number(req.params.requestId) },
        relations: ['media'],
      });

      const days = Number(req.body.days);

      if (days > 0) {
        request.autoDeleteDays = days;

        logger.info('Auto-delete set for request', {
          label: 'Auto-Delete API',
          requestId: request.id,
          days,
        });
      } else {
        request.autoDeleteDays = null;
        request.autoDeleteDate = null as any;

        logger.info('Auto-delete removed from request', {
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

autoDeleteRoutes.get(
  '/auto-delete/:requestId',
  isAuthenticated(Permission.MANAGE_REQUESTS),
  async (req: Request, res: Response, next: NextFunction) => {
    const requestRepository = getRepository(MediaRequest);

    try {
      const request = await requestRepository.findOneOrFail({
        where: { id: Number(req.params.requestId) },
        relations: ['media'],
      });

      let daysRemaining: number | null = null;
      let expiresAt: Date | null = null;

      if (request.autoDeleteDays && request.media?.mediaAddedAt) {
        const addedAt = new Date(request.media.mediaAddedAt);
        expiresAt = new Date(addedAt);
        expiresAt.setDate(expiresAt.getDate() + request.autoDeleteDays);
        daysRemaining = Math.ceil(
          (expiresAt.getTime() - Date.now()) / 1000 / 60 / 60 / 24
        );
      }

      return res.status(200).json({
        requestId: request.id,
        autoDeleteDays: request.autoDeleteDays,
        mediaAddedAt: request.media?.mediaAddedAt ?? null,
        expiresAt,
        daysRemaining,
        countdownStarted: !!request.media?.mediaAddedAt,
      });
    } catch (e) {
      next({ status: 404, message: 'Request not found.' });
    }
  }
);

export default autoDeleteRoutes;
