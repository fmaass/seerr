import { getRepository } from '@server/datasource';
import { MediaRequest } from '@server/entity/MediaRequest';
import { User } from '@server/entity/User';
import { Permission } from '@server/lib/permissions';
import logger from '@server/logger';
import { isAuthenticated } from '@server/middleware/auth';
import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';

const autoDeleteRoutes = Router();

autoDeleteRoutes.post(
  '/auto-delete/:requestId',
  isAuthenticated(Permission.MANAGE_REQUESTS),
  async (req: Request, res: Response, next: NextFunction) => {
    const requestRepository = getRepository(MediaRequest);
    const rawUserId = req.body?.userId;
    const reassign = rawUserId !== undefined && rawUserId !== null;

    // Reassigning the owner is a user-management act, not a request edit.
    if (
      reassign &&
      !req.user?.hasPermission([
        Permission.MANAGE_REQUESTS,
        Permission.MANAGE_USERS,
      ])
    ) {
      return next({
        status: 403,
        message: 'You do not have permission to reassign this request.',
      });
    }

    const userId = Number(rawUserId);
    if (
      reassign &&
      (!['number', 'string'].includes(typeof rawUserId) ||
        !Number.isInteger(userId) ||
        userId <= 0)
    ) {
      return next({ status: 400, message: 'Invalid userId.' });
    }

    const requestId = Number(req.params.requestId);
    if (!Number.isInteger(requestId) || requestId <= 0) {
      return next({ status: 404, message: 'Request not found.' });
    }

    try {
      const request = await requestRepository.findOne({
        where: { id: requestId },
      });
      if (!request) {
        return next({ status: 404, message: 'Request not found.' });
      }

      let newOwner: User | null = null;
      if (reassign) {
        newOwner = await getRepository(User).findOne({
          where: { id: userId },
        });
        if (!newOwner) {
          return next({ status: 400, message: 'User not found.' });
        }
      }

      const days = Number(req.body?.days);
      const changes: QueryDeepPartialEntity<MediaRequest> =
        days > 0
          ? { autoDeleteDays: days }
          : { autoDeleteDays: null, autoDeleteDate: () => 'NULL' };
      if (newOwner) {
        changes.requestedBy = { id: newOwner.id };
      }

      // Listeners stay off: a save() would let the request subscriber resend
      // an APPROVED request to the arr or re-announce a COMPLETED one.
      await requestRepository
        .createQueryBuilder()
        .update(MediaRequest)
        .set(changes)
        .where('id = :id', { id: request.id })
        .callListeners(false)
        .execute();

      logger.info(
        days > 0
          ? 'Auto-delete set for request'
          : 'Auto-delete removed from request',
        {
          label: 'Auto-Delete API',
          requestId: request.id,
          ...(days > 0 ? { days } : {}),
          ...(newOwner ? { reassignedTo: newOwner.id } : {}),
        }
      );

      const updated = await requestRepository.findOneOrFail({
        where: { id: request.id },
        relations: ['media'],
      });

      return res.status(200).json(updated);
    } catch (e) {
      logger.error('Error setting auto-delete', {
        label: 'Auto-Delete API',
        requestId,
        error: e.message,
      });
      next({ status: 500, message: 'Unable to update auto-delete.' });
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
    } catch {
      next({ status: 404, message: 'Request not found.' });
    }
  }
);

export default autoDeleteRoutes;
