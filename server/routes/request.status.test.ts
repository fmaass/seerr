import assert from 'node:assert/strict';
import { before, describe, it, mock } from 'node:test';

import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import { User } from '@server/entity/User';
import { Permission } from '@server/lib/permissions';
import Settings, { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { checkUser, isAuthenticated } from '@server/middleware/auth';
import { setupTestDb } from '@server/test/db';
import type { Express } from 'express';
import express from 'express';
import session from 'express-session';
import request from 'supertest';
import authRoutes from './auth';
import requestRoutes from './request';
import settingsRoutes from './settings';

mock.method(MediaRequest, 'sendNotification', async () => undefined);
// Keep the real settings.save() from writing test data into config/settings.json.
mock.method(Settings.prototype, 'save', async () => undefined);

let app: Express;

// Same harness as server/routes/request.test.ts, plus the settings router
// mounted behind the admin guard used by server/routes/index.ts:156 and the
// auto-delete router which request.ts mounts under /request.
function createApp() {
  const app = express();
  app.use(express.json());
  app.use(
    session({
      secret: 'test-secret',
      resave: false,
      saveUninitialized: false,
    })
  );
  app.use(checkUser);
  app.use('/auth', authRoutes);
  app.use('/request', requestRoutes);
  app.use('/settings', isAuthenticated(Permission.ADMIN), settingsRoutes);
  app.use(
    (
      err: { status?: number; message?: string },
      _req: express.Request,
      res: express.Response,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      _next: express.NextFunction
    ) => {
      res
        .status(err.status ?? 500)
        .json({ status: err.status ?? 500, message: err.message });
    }
  );
  return app;
}

before(async () => {
  app = createApp();
});

setupTestDb();

async function loginAs(email: string, password: string) {
  const settings = getSettings();
  const priorLocalLogin = settings.main.localLogin;
  settings.main.localLogin = true;

  try {
    const agent = request.agent(app);
    const res = await agent.post('/auth/local').send({ email, password });
    assert.strictEqual(res.status, 200);
    return agent;
  } finally {
    settings.main.localLogin = priorLocalLogin;
  }
}

async function seedRequest(
  status = MediaRequestStatus.PENDING,
  init: Partial<MediaRequest> = {}
) {
  const userRepo = getRepository(User);
  const mediaRepo = getRepository(Media);
  const requestRepo = getRepository(MediaRequest);

  const requestedBy = await userRepo.findOneOrFail({
    where: { email: 'friend@seerr.dev' },
  });

  const media = await mediaRepo.save(
    new Media({
      mediaType: MediaType.MOVIE,
      tmdbId: 12345,
      status: MediaStatus.UNKNOWN,
      status4k: MediaStatus.UNKNOWN,
    })
  );

  const created = await requestRepo.save(
    new MediaRequest({
      type: MediaType.MOVIE,
      status,
      media,
      requestedBy,
      is4k: false,
      updatedAt: new Date('2025-03-01T00:00:00.000Z'),
      ...init,
    })
  );

  return requestRepo.findOneOrFail({
    where: { id: created.id },
    relations: { requestedBy: true, modifiedBy: true },
  });
}

type LoggerErrorCall = { message: unknown; meta: Record<string, unknown> };

// The logger is silenced by server/test/setup.ts, so a transport listener would
// see nothing; spy on the method instead.
function spyOnLoggerError(calls: LoggerErrorCall[]) {
  const impl = (...args: unknown[]) => {
    calls.push({
      message: args[0],
      meta: (args[1] ?? {}) as Record<string, unknown>,
    });
    return logger;
  };

  return mock.method(logger, 'error', impl as unknown as typeof logger.error);
}

describe('POST /request/:requestId/:status (approve)', () => {
  it('persists the requested auto-delete window and the acting user', async () => {
    const repo = getRepository(MediaRequest);
    const pending = await seedRequest();
    const admin = await loginAs('admin@seerr.dev', 'test1234');

    const res = await admin
      .post(`/request/${pending.id}/approve`)
      .send({ autoDeleteDays: 7 });

    assert.strictEqual(res.status, 200);

    const persisted = await repo.findOneOrFail({
      where: { id: pending.id },
      relations: { modifiedBy: true },
    });

    assert.strictEqual(persisted.status, MediaRequestStatus.APPROVED);
    assert.strictEqual(persisted.autoDeleteDays, 7);
    assert.strictEqual(persisted.modifiedBy?.email, 'admin@seerr.dev');
  });

  it('answers 404 when the request does not exist', async () => {
    const admin = await loginAs('admin@seerr.dev', 'test1234');

    const res = await admin.post('/request/99999999/approve').send({});

    assert.strictEqual(res.status, 404);
  });

  it('answers 500 with a truthful log when the save fails', async () => {
    const repo = getRepository(MediaRequest);
    const pending = await seedRequest();
    const admin = await loginAs('admin@seerr.dev', 'test1234');

    // Stub AFTER the fixture exists: getRepository returns the same cached
    // repository object for the entity, so this is the route's repository too.
    const save = mock.method(repo, 'save', async () => {
      throw new Error('boom');
    });
    const errorCalls: LoggerErrorCall[] = [];
    const errorSpy = spyOnLoggerError(errorCalls);

    try {
      const res = await admin.post(`/request/${pending.id}/approve`).send({});

      assert.strictEqual(res.status, 500);
      assert.strictEqual(save.mock.callCount(), 1);

      const calls = errorCalls.filter(
        (call) => call.message === 'Error processing request update'
      );
      assert.strictEqual(calls.length, 1);

      const meta = calls[0].meta;
      assert.strictEqual(meta.requestId, pending.id);
      assert.strictEqual(meta.errorMessage, 'boom');
      // winston's format.splat() lets a meta `message` replace the log message,
      // so the meta must not carry one.
      assert.ok(!('message' in meta));
    } finally {
      errorSpy.mock.restore();
      save.mock.restore();
    }
  });

  it('answers 500 for a non-numeric request id', async () => {
    const admin = await loginAs('admin@seerr.dev', 'test1234');

    // Number('abc') is NaN, so the lookup fails with a QueryFailedError rather
    // than an EntityNotFoundError: malformed input is not "not found".
    const res = await admin.post('/request/abc/approve').send({});

    assert.strictEqual(res.status, 500);
  });
});

describe('POST /request/:requestId/retry', () => {
  it('answers 404 when the request does not exist', async () => {
    const admin = await loginAs('admin@seerr.dev', 'test1234');

    const res = await admin.post('/request/99999999/retry').send({});

    assert.strictEqual(res.status, 404);
  });

  it('answers 500 with a truthful log when the save fails', async () => {
    const repo = getRepository(MediaRequest);
    const failed = await seedRequest(MediaRequestStatus.FAILED);
    const admin = await loginAs('admin@seerr.dev', 'test1234');

    const save = mock.method(repo, 'save', async () => {
      throw new Error('boom');
    });
    const errorCalls: LoggerErrorCall[] = [];
    const errorSpy = spyOnLoggerError(errorCalls);

    try {
      const res = await admin.post(`/request/${failed.id}/retry`).send({});

      assert.strictEqual(res.status, 500);
      assert.strictEqual(save.mock.callCount(), 1);

      const calls = errorCalls.filter(
        (call) => call.message === 'Error processing request retry'
      );
      assert.strictEqual(calls.length, 1);

      const meta = calls[0].meta;
      assert.strictEqual(meta.requestId, failed.id);
      assert.strictEqual(meta.errorMessage, 'boom');
      assert.ok(!('message' in meta));
    } finally {
      errorSpy.mock.restore();
      save.mock.restore();
    }
  });
});

describe('POST /request/auto-delete/:requestId without a body', () => {
  it('clears the auto-delete timer instead of failing', async () => {
    const repo = getRepository(MediaRequest);
    const timed = await seedRequest(MediaRequestStatus.APPROVED, {
      autoDeleteDays: 14,
      autoDeleteDate: new Date('2025-04-01T00:00:00.000Z'),
    });
    assert.strictEqual(timed.autoDeleteDays, 14);
    const admin = await loginAs('admin@seerr.dev', 'test1234');

    // Express 5 leaves req.body undefined on a body-less POST.
    const res = await admin.post(`/request/auto-delete/${timed.id}`);

    assert.strictEqual(res.status, 200);

    const persisted = await repo.findOneOrFail({ where: { id: timed.id } });
    assert.strictEqual(persisted.autoDeleteDays, null);
    assert.strictEqual(persisted.autoDeleteDate ?? null, null);
  });
});

describe('POST /settings/main without a body', () => {
  it('leaves the main settings untouched instead of failing', async () => {
    const settings = getSettings();
    const priorExempt = settings.main.documentaryExemptUserIds;
    const priorTitle = settings.main.applicationTitle;
    settings.main.documentaryExemptUserIds = [1, 2];

    const admin = await loginAs('admin@seerr.dev', 'test1234');

    try {
      const res = await admin.post('/settings/main');

      assert.strictEqual(res.status, 200);
      assert.deepStrictEqual(
        getSettings().main.documentaryExemptUserIds,
        [1, 2]
      );
      assert.strictEqual(getSettings().main.applicationTitle, priorTitle);
    } finally {
      settings.main.documentaryExemptUserIds = priorExempt;
    }
  });
});
