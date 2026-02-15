import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import type {
  Permission,
  PermissionCheckOptions,
} from '@server/lib/permissions';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';

export const checkUser: Middleware = async (req, _res, next) => {
  const settings = getSettings();
  let user: User | undefined | null;

  if (req.header('X-API-Key') === settings.main.apiKey) {
    const userRepository = getRepository(User);

    let userId = 1; // Work on original administrator account

    // If a User ID is provided, we will act on that user's behalf
    if (req.header('X-API-User')) {
      userId = Number(req.header('X-API-User'));
    }

    logger.info('API Key authentication attempt', {
      label: 'Auth',
      userId,
      path: req.path,
      hasApiKey: !!req.header('X-API-Key'),
    });

    user = await userRepository.findOne({ where: { id: userId } });

    if (!user) {
      logger.warn('User not found for API key authentication', {
        label: 'Auth',
        userId,
        path: req.path,
      });
    } else {
      logger.info('User loaded via API key', {
        label: 'Auth',
        userId: user.id,
        userPermissions: user.permissions,
        path: req.path,
      });
    }
  } else if (req.session?.userId) {
    const userRepository = getRepository(User);

    user = await userRepository.findOne({
      where: { id: req.session.userId },
    });
  }

  if (user) {
    req.user = user;
  }

  req.locale = user?.settings?.locale
    ? user.settings.locale
    : settings.main.locale;

  next();
};

export const isAuthenticated = (
  permissions?: Permission | Permission[],
  options?: PermissionCheckOptions
): Middleware => {
  const authMiddleware: Middleware = (req, res, next) => {
    if (!req.user) {
      logger.warn('Authentication failed: no user in request', {
        label: 'Auth',
        path: req.path,
        method: req.method,
      });
      res.status(403).json({
        status: 403,
        error: 'You do not have permission to access this endpoint',
      });
      return;
    }

    const hasPermission = req.user.hasPermission(permissions ?? 0, options);
    if (!hasPermission) {
      logger.warn('Permission check failed', {
        label: 'Auth',
        userId: req.user.id,
        userPermissions: req.user.permissions,
        requiredPermissions: permissions,
        path: req.path,
        method: req.method,
      });
      res.status(403).json({
        status: 403,
        error: 'You do not have permission to access this endpoint',
      });
      return;
    }

    next();
  };
  return authMiddleware;
};
