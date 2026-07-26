import assert from 'node:assert/strict';
import { beforeEach, describe, it, mock } from 'node:test';

import TheMovieDb from '@server/api/themoviedb';
import { MediaStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import {
  BlocklistedMediaError,
  MediaRequest,
} from '@server/entity/MediaRequest';
import { User } from '@server/entity/User';
import type { MediaRequestBody } from '@server/interfaces/api/requestInterfaces';
import { Permission } from '@server/lib/permissions';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { checkUser, isAuthenticated } from '@server/middleware/auth';
import { setupTestDb } from '@server/test/db';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import requestRoutes from './request';

const DOCUMENTARY_BLOCK_MESSAGE =
  'Documentaries are blocked and cannot be requested.';
const BYPASS_LOG_MESSAGE =
  'Documentary genre filter bypassed for exempt request owner';
const BLOCK_LOG_MESSAGE =
  'Request for media blocked due to documentary genre filter';

const documentaryGenre = { id: 99, name: 'Documentary' };
const dramaGenre = { id: 18, name: 'Drama' };

let tmdbGenres = [documentaryGenre];

Object.defineProperty(TheMovieDb.prototype, 'getMovie', {
  get() {
    return async ({ movieId }: { movieId: number }) => ({
      id: movieId,
      title: `Test Movie ${movieId}`,
      genres: tmdbGenres,
      original_language: 'en',
      external_ids: { tvdb_id: null },
      keywords: { keywords: [] },
    });
  },
  set() {},
  configurable: true,
});

const sendNotificationMock = mock.method(
  MediaRequest,
  'sendNotification',
  async () => undefined
).mock;

beforeEach(() => {
  sendNotificationMock.resetCalls();
  tmdbGenres = [documentaryGenre];
});

setupTestDb();

async function setPermissions(email: string, permissions: number) {
  const userRepository = getRepository(User);
  const user = await userRepository.findOneOrFail({ where: { email } });
  user.permissions = permissions;
  return userRepository.save(user);
}

async function createOwner(email: string, permissions: number) {
  return getRepository(User).save(
    new User({
      email,
      username: email.split('@')[0],
      permissions,
      avatar: '',
    })
  );
}

function applySettings(exemptUserIds: number[]) {
  const settings = getSettings();
  const prior = {
    blockDocumentaryGenre: settings.main.blockDocumentaryGenre,
    documentaryExemptUserIds: settings.main.documentaryExemptUserIds,
    apiKey: settings.main.apiKey,
  };

  settings.main.blockDocumentaryGenre = true;
  settings.main.documentaryExemptUserIds = exemptUserIds;

  return () => {
    settings.main.blockDocumentaryGenre = prior.blockDocumentaryGenre;
    settings.main.documentaryExemptUserIds = prior.documentaryExemptUserIds;
    settings.main.apiKey = prior.apiKey;
  };
}

type LogCall = { message: string; meta?: Record<string, unknown> };

function captureLogger() {
  const info: LogCall[] = [];
  const warn: LogCall[] = [];
  const originalInfo = logger.info;
  const originalWarn = logger.warn;

  logger.info = ((message: string, meta?: Record<string, unknown>) => {
    info.push({ message, meta });
    return logger;
  }) as typeof logger.info;
  logger.warn = ((message: string, meta?: Record<string, unknown>) => {
    warn.push({ message, meta });
    return logger;
  }) as typeof logger.warn;

  return {
    info,
    warn,
    restore: () => {
      logger.info = originalInfo;
      logger.warn = originalWarn;
    },
  };
}

function movieBody(
  mediaId: number,
  overrides: Partial<MediaRequestBody> = {}
): MediaRequestBody {
  return { mediaType: MediaType.MOVIE, mediaId, ...overrides };
}

async function countRows() {
  return {
    requests: await getRepository(MediaRequest).count(),
    media: await getRepository(Media).count(),
  };
}

function assertDocumentaryBlock(error: unknown) {
  assert.ok(
    error instanceof BlocklistedMediaError,
    `expected BlocklistedMediaError, got ${error}`
  );
  assert.strictEqual(error.message, DOCUMENTARY_BLOCK_MESSAGE);
  return true;
}

type RouterWithStack = {
  stack: {
    route?: {
      path: string;
      methods: Record<string, boolean>;
      stack: { handle: RequestHandler }[];
    };
  }[];
};

function getRouteHandler(path: string, method: string): RequestHandler {
  const layer = (requestRoutes as unknown as RouterWithStack).stack.find(
    ({ route }) => route?.path === path && route.methods[method]
  );
  const handler = layer?.route?.stack.at(-1)?.handle;
  assert.ok(handler, `missing ${method.toUpperCase()} ${path} route handler`);
  return handler;
}

function createResponse() {
  const result: { status?: number; body?: unknown } = {};
  const response = {
    status(status: number) {
      result.status = status;
      return response;
    },
    json(body: unknown) {
      result.body = body;
      return response;
    },
  };

  return { result, response: response as unknown as Response };
}

async function runMiddleware(handler: RequestHandler, request: Request) {
  const { response } = createResponse();
  let nextCalled = false;
  let nextError: unknown;
  const next: NextFunction = (error?: unknown) => {
    nextCalled = true;
    nextError = error;
  };

  await handler(request, response, next);
  assert.strictEqual(nextError, undefined);
  assert.ok(nextCalled, 'expected middleware to call next()');
}

async function postRequestEndpoint(request: Request) {
  const { result, response } = createResponse();
  let nextError: unknown;

  await getRouteHandler('/', 'post')(request, response, ((error?: unknown) => {
    nextError = error;
  }) as NextFunction);

  assert.strictEqual(nextError, undefined);
  return result;
}

describe('documentary exemption by request owner', () => {
  it('allows an exempt request owner to request a documentary', async () => {
    const owner = await setPermissions(
      'friend@seerr.dev',
      Permission.REQUEST | Permission.REQUEST_MOVIE
    );
    const restoreSettings = applySettings([owner.id]);
    const logs = captureLogger();

    try {
      const created = await MediaRequest.request(movieBody(601001), owner);

      assert.strictEqual(created.requestedBy.id, owner.id);
      assert.strictEqual(created.is4k, false);
      assert.strictEqual(created.media.tmdbId, 601001);
      assert.strictEqual(created.media.status, MediaStatus.PENDING);

      const bypassLog = logs.info.find((c) => c.message === BYPASS_LOG_MESSAGE);
      assert.ok(bypassLog, 'expected a documentary bypass log entry');
      assert.strictEqual(bypassLog.meta?.tmdbId, 601001);
      assert.strictEqual(bypassLog.meta?.ownerId, owner.id);
      assert.strictEqual(
        logs.warn.filter((c) => c.message === BLOCK_LOG_MESSAGE).length,
        0
      );
    } finally {
      logs.restore();
      restoreSettings();
    }
  });

  it('allows an exempt request owner with 4K permission to request a 4K documentary', async () => {
    const owner = await setPermissions(
      'friend@seerr.dev',
      Permission.REQUEST_4K | Permission.REQUEST_4K_MOVIE
    );
    const restoreSettings = applySettings([owner.id]);

    try {
      const created = await MediaRequest.request(
        movieBody(601002, { is4k: true }),
        owner
      );

      assert.strictEqual(created.requestedBy.id, owner.id);
      assert.strictEqual(created.is4k, true);
      assert.strictEqual(created.media.tmdbId, 601002);
      assert.strictEqual(created.media.status4k, MediaStatus.PENDING);
    } finally {
      restoreSettings();
    }
  });

  it('throws today’s documentary error for a non-exempt request owner', async () => {
    const owner = await setPermissions(
      'friend@seerr.dev',
      Permission.REQUEST | Permission.REQUEST_MOVIE
    );
    const restoreSettings = applySettings([owner.id + 1000]);

    try {
      await assert.rejects(
        () => MediaRequest.request(movieBody(601003), owner),
        assertDocumentaryBlock
      );
    } finally {
      restoreSettings();
    }
  });

  it('uses the exempt body userId owner rather than the non-exempt privileged caller', async () => {
    const caller = await setPermissions(
      'friend@seerr.dev',
      Permission.REQUEST |
        Permission.REQUEST_MOVIE |
        Permission.MANAGE_USERS |
        Permission.MANAGE_REQUESTS
    );
    const owner = await createOwner(
      'exempt-owner@seerr.dev',
      Permission.REQUEST | Permission.REQUEST_MOVIE
    );
    const restoreSettings = applySettings([owner.id]);

    try {
      assert.notStrictEqual(caller.id, owner.id);
      const created = await MediaRequest.request(
        movieBody(601004, { userId: owner.id }),
        caller
      );

      assert.strictEqual(created.requestedBy.id, owner.id);
      assert.strictEqual(created.media.tmdbId, 601004);
    } finally {
      restoreSettings();
    }
  });

  it('does not use an exempt privileged caller when the body userId owner is non-exempt', async () => {
    const caller = await setPermissions(
      'friend@seerr.dev',
      Permission.REQUEST |
        Permission.REQUEST_MOVIE |
        Permission.MANAGE_USERS |
        Permission.MANAGE_REQUESTS
    );
    const owner = await createOwner(
      'blocked-owner@seerr.dev',
      Permission.REQUEST | Permission.REQUEST_MOVIE
    );
    const restoreSettings = applySettings([caller.id]);

    try {
      await assert.rejects(
        () =>
          MediaRequest.request(movieBody(601005, { userId: owner.id }), caller),
        assertDocumentaryBlock
      );
    } finally {
      restoreSettings();
    }
  });

  it('allows the POST endpoint for an exempt X-API-User loaded by the auth middleware', async () => {
    const owner = await setPermissions(
      'friend@seerr.dev',
      Permission.REQUEST | Permission.REQUEST_MOVIE
    );
    const restoreSettings = applySettings([owner.id]);
    const apiKey = 'documentary-exemption-test-key';
    getSettings().main.apiKey = apiKey;
    const headers: Record<string, string> = {
      'x-api-key': apiKey,
      'x-api-user': String(owner.id),
    };
    const endpointRequest = {
      body: movieBody(601006),
      path: '/request',
      session: {},
      header: (name: string) => headers[name.toLowerCase()],
    } as unknown as Request;

    try {
      await runMiddleware(checkUser as RequestHandler, endpointRequest);
      await runMiddleware(isAuthenticated(), endpointRequest);
      const result = await postRequestEndpoint(endpointRequest);

      assert.strictEqual(result.status, 201);
      const saved = await getRepository(MediaRequest).findOneOrFail({
        where: { media: { tmdbId: 601006 } },
        relations: { requestedBy: true },
      });
      assert.strictEqual(saved.requestedBy.id, owner.id);
    } finally {
      restoreSettings();
    }
  });

  it('still lets a non-admin MANAGE_BLOCKLIST holder override the documentary block', async () => {
    const owner = await setPermissions(
      'friend@seerr.dev',
      Permission.REQUEST |
        Permission.REQUEST_MOVIE |
        Permission.MANAGE_BLOCKLIST
    );
    const restoreSettings = applySettings([]);

    try {
      assert.strictEqual(owner.permissions & Permission.ADMIN, 0);
      const created = await MediaRequest.request(movieBody(601007), owner);

      assert.strictEqual(created.requestedBy.id, owner.id);
      assert.strictEqual(created.media.tmdbId, 601007);
    } finally {
      restoreSettings();
    }
  });

  it('still lets an ADMIN user override the documentary block through the permission short-circuit', async () => {
    const admin = await setPermissions('admin@seerr.dev', Permission.ADMIN);
    const restoreSettings = applySettings([]);

    try {
      assert.strictEqual(admin.permissions & Permission.MANAGE_BLOCKLIST, 0);
      const created = await MediaRequest.request(movieBody(601008), admin);

      assert.strictEqual(created.requestedBy.id, admin.id);
      assert.strictEqual(created.media.tmdbId, 601008);
    } finally {
      restoreSettings();
    }
  });

  it('leaves a non-documentary request from a non-exempt owner unaffected', async () => {
    const owner = await setPermissions(
      'friend@seerr.dev',
      Permission.REQUEST | Permission.REQUEST_MOVIE
    );
    const restoreSettings = applySettings([]);
    tmdbGenres = [dramaGenre];

    try {
      const created = await MediaRequest.request(movieBody(601009), owner);

      assert.strictEqual(created.requestedBy.id, owner.id);
      assert.strictEqual(created.media.tmdbId, 601009);
    } finally {
      restoreSettings();
    }
  });

  it('preserves empty-list error, warning, and database behavior', async () => {
    const owner = await setPermissions(
      'friend@seerr.dev',
      Permission.REQUEST | Permission.REQUEST_MOVIE
    );
    const restoreSettings = applySettings([]);
    const logs = captureLogger();

    try {
      await assert.rejects(
        () => MediaRequest.request(movieBody(601010), owner),
        assertDocumentaryBlock
      );

      const blockLog = logs.warn.find((c) => c.message === BLOCK_LOG_MESSAGE);
      assert.ok(blockLog, 'expected the documentary block warning');
      assert.strictEqual(blockLog.meta?.tmdbId, 601010);
      assert.strictEqual(
        logs.info.filter((c) => c.message === BYPASS_LOG_MESSAGE).length,
        0
      );
      assert.deepStrictEqual(await countRows(), { requests: 0, media: 0 });
    } finally {
      logs.restore();
      restoreSettings();
    }
  });
});
