import assert from 'node:assert/strict';
import { before, beforeEach, describe, it, mock } from 'node:test';

import TheMovieDb from '@server/api/themoviedb';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import { User } from '@server/entity/User';
import notificationManager, { Notification } from '@server/lib/notifications';
import { Permission } from '@server/lib/permissions';
import Settings, { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { checkUser } from '@server/middleware/auth';
import { MediaRequestSubscriber } from '@server/subscriber/MediaRequestSubscriber';
import { MediaSubscriber } from '@server/subscriber/MediaSubscriber';
import { setupTestDb } from '@server/test/db';
import type { Express } from 'express';
import express from 'express';
import session from 'express-session';
import request from 'supertest';
import { UpdateQueryBuilder } from 'typeorm';
import authRoutes from './auth';
import requestRoutes from './request';

// The real subscribers stay registered on the test datasource; only their
// outbound effects are replaced, so a write that reaches them is counted.
const sendToRadarr = mock.method(
  MediaRequestSubscriber.prototype,
  'sendToRadarr',
  async () => undefined
).mock;
mock.method(
  MediaRequestSubscriber.prototype,
  'sendToSonarr',
  async () => undefined
);
const requestAfterUpdate = mock.method(
  MediaRequestSubscriber.prototype,
  'afterUpdate'
).mock;
const mediaAfterUpdate = mock.method(
  MediaSubscriber.prototype,
  'afterUpdate'
).mock;
const sendNotification = mock.method(
  notificationManager,
  'sendNotification',
  () => undefined
).mock;
mock.method(Settings.prototype, 'save', async () => undefined);

Object.defineProperty(TheMovieDb.prototype, 'getMovie', {
  get() {
    return async ({ movieId }: { movieId: number }) => ({
      id: movieId,
      title: `Test Movie ${movieId}`,
      release_date: '2020-01-01',
      genres: [],
      original_language: 'en',
      external_ids: { tvdb_id: null },
      keywords: { keywords: [] },
    });
  },
  set() {},
  configurable: true,
});

function resetSpies() {
  sendToRadarr.resetCalls();
  requestAfterUpdate.resetCalls();
  mediaAfterUpdate.resetCalls();
  sendNotification.resetCalls();
}

function availabilityNotifications() {
  return sendNotification.calls.filter(
    (call) => call.arguments[0] === Notification.MEDIA_AVAILABLE
  ).length;
}

let app: Express;

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

beforeEach(() => {
  resetSpies();
});

async function loginAs(email: string) {
  const settings = getSettings();
  const priorLocalLogin = settings.main.localLogin;
  settings.main.localLogin = true;

  try {
    const agent = request.agent(app);
    const res = await agent
      .post('/auth/local')
      .send({ email, password: 'test1234' });
    assert.strictEqual(res.status, 200);
    return agent;
  } finally {
    settings.main.localLogin = priorLocalLogin;
  }
}

async function setPermissions(email: string, permissions: number) {
  const repo = getRepository(User);
  const user = await repo.findOneOrFail({ where: { email } });
  user.permissions = permissions;
  return repo.save(user);
}

async function createUser(email: string) {
  return getRepository(User).save(
    new User({
      email,
      username: email.split('@')[0],
      permissions: Permission.REQUEST,
      avatar: '',
    })
  );
}

async function seedRequest(
  status: MediaRequestStatus,
  mediaStatus = MediaStatus.AVAILABLE
) {
  const requestedBy = await getRepository(User).findOneOrFail({
    where: { email: 'demo@seerr.dev' },
  });
  const media = await getRepository(Media).save(
    new Media({
      mediaType: MediaType.MOVIE,
      tmdbId: 2001,
      status: mediaStatus,
      status4k: MediaStatus.UNKNOWN,
      mediaAddedAt: new Date(),
    })
  );
  const created = await getRepository(MediaRequest).save(
    new MediaRequest({
      type: MediaType.MOVIE,
      status,
      media,
      requestedBy,
      is4k: false,
      autoDeleteDays: 30,
    })
  );
  resetSpies();
  return created.id;
}

async function readRequest(id: number) {
  return getRepository(MediaRequest).findOneOrFail({
    where: { id },
    relations: { requestedBy: true, media: true },
  });
}

describe('POST /request/auto-delete/:requestId reassigning the owner', () => {
  for (const status of [
    MediaRequestStatus.APPROVED,
    MediaRequestStatus.COMPLETED,
  ]) {
    it(`sets days and reassigns requestedBy on a ${MediaRequestStatus[status]} request`, async () => {
      const id = await seedRequest(status);
      const newOwner = await createUser('owner@seerr.dev');
      const admin = await loginAs('admin@seerr.dev');

      const res = await admin
        .post(`/request/auto-delete/${id}`)
        .send({ days: 14, userId: newOwner.id });

      assert.strictEqual(res.status, 200);
      const persisted = await readRequest(id);
      assert.strictEqual(persisted.requestedBy.id, newOwner.id);
      assert.strictEqual(persisted.autoDeleteDays, 14);
      assert.strictEqual(persisted.status, status);
    });
  }

  it('refuses userId from a MANAGE_REQUESTS holder without MANAGE_USERS and writes nothing', async () => {
    const id = await seedRequest(MediaRequestStatus.APPROVED);
    const newOwner = await createUser('owner@seerr.dev');
    const demo = await setPermissions(
      'demo@seerr.dev',
      Permission.MANAGE_REQUESTS
    );
    const manager = await loginAs('demo@seerr.dev');

    const res = await manager
      .post(`/request/auto-delete/${id}`)
      .send({ days: 14, userId: newOwner.id });

    assert.strictEqual(res.status, 403);
    const persisted = await readRequest(id);
    assert.strictEqual(persisted.requestedBy.id, demo.id);
    assert.strictEqual(persisted.autoDeleteDays, 30);
  });

  it('still lets a MANAGE_REQUESTS holder set days without a userId', async () => {
    const id = await seedRequest(MediaRequestStatus.APPROVED);
    await setPermissions('demo@seerr.dev', Permission.MANAGE_REQUESTS);
    const manager = await loginAs('demo@seerr.dev');

    const res = await manager
      .post(`/request/auto-delete/${id}`)
      .send({ days: 7 });

    assert.strictEqual(res.status, 200);
    assert.strictEqual((await readRequest(id)).autoDeleteDays, 7);
  });

  it('answers 4xx for a userId that does not exist and writes nothing', async () => {
    const id = await seedRequest(MediaRequestStatus.APPROVED);
    const admin = await loginAs('admin@seerr.dev');

    const res = await admin
      .post(`/request/auto-delete/${id}`)
      .send({ days: 14, userId: 999999 });

    assert.ok(
      res.status >= 400 && res.status < 500,
      `expected 4xx, got ${res.status}`
    );
    assert.notStrictEqual(res.status, 404);
    const persisted = await readRequest(id);
    assert.strictEqual(persisted.requestedBy.email, 'demo@seerr.dev');
    assert.strictEqual(persisted.autoDeleteDays, 30);
  });

  for (const userId of ['abc', 0, -1, 1.5, true, '']) {
    it(`answers 400 for userId ${JSON.stringify(userId)}`, async () => {
      const id = await seedRequest(MediaRequestStatus.APPROVED);
      const admin = await loginAs('admin@seerr.dev');

      const res = await admin
        .post(`/request/auto-delete/${id}`)
        .send({ days: 14, userId });

      assert.strictEqual(res.status, 400);
      const persisted = await readRequest(id);
      assert.strictEqual(persisted.autoDeleteDays, 30);
      assert.strictEqual(persisted.requestedBy.email, 'demo@seerr.dev');
    });
  }

  it('reassigns for a userId sent as a numeric string', async () => {
    const id = await seedRequest(MediaRequestStatus.APPROVED);
    const newOwner = await createUser('owner@seerr.dev');
    const admin = await loginAs('admin@seerr.dev');

    const res = await admin
      .post(`/request/auto-delete/${id}`)
      .send({ days: 14, userId: String(newOwner.id) });

    assert.strictEqual(res.status, 200);
    assert.strictEqual((await readRequest(id)).requestedBy.id, newOwner.id);
  });

  it('answers 500, not 404, when the write fails', async () => {
    const id = await seedRequest(MediaRequestStatus.APPROVED);
    const admin = await loginAs('admin@seerr.dev');
    const errors: unknown[] = [];
    const error = mock.method(logger, 'error', ((...args: unknown[]) => {
      errors.push(args[0]);
      return logger;
    }) as unknown as typeof logger.error);
    const failing = mock.method(
      UpdateQueryBuilder.prototype,
      'execute',
      async () => {
        throw new Error('write failed');
      }
    );

    try {
      const res = await admin
        .post(`/request/auto-delete/${id}`)
        .send({ days: 14 });

      assert.strictEqual(res.status, 500);
      assert.ok(errors.includes('Error setting auto-delete'));
    } finally {
      failing.mock.restore();
      error.mock.restore();
    }
    assert.strictEqual((await readRequest(id)).autoDeleteDays, 30);
  });

  it('keeps 404 for a request that does not exist', async () => {
    const admin = await loginAs('admin@seerr.dev');

    const res = await admin
      .post('/request/auto-delete/999999')
      .send({ days: 14 });

    assert.strictEqual(res.status, 404);
  });
});

describe('POST /request/auto-delete/:requestId stays silent (e)', () => {
  it('a plain save of the fixture would notify, proving the subscribers are live', async () => {
    const id = await seedRequest(MediaRequestStatus.COMPLETED);
    const repo = getRepository(MediaRequest);
    const fixture = await readRequest(id);
    fixture.autoDeleteDays = 14;
    await repo.save(fixture);

    assert.ok(requestAfterUpdate.callCount() > 0);
    assert.ok(availabilityNotifications() > 0);
  });

  it('neither sends to Radarr nor notifies availability on a COMPLETED request', async () => {
    const id = await seedRequest(MediaRequestStatus.COMPLETED);
    const newOwner = await createUser('owner@seerr.dev');
    const admin = await loginAs('admin@seerr.dev');
    resetSpies();

    const res = await admin
      .post(`/request/auto-delete/${id}`)
      .send({ days: 14, userId: newOwner.id });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(sendToRadarr.callCount(), 0);
    assert.strictEqual(availabilityNotifications(), 0);
    assert.strictEqual(sendNotification.callCount(), 0);
    assert.strictEqual(requestAfterUpdate.callCount(), 0);
    assert.strictEqual(mediaAfterUpdate.callCount(), 0);
  });

  it('does not re-send an APPROVED request to Radarr when the days change', async () => {
    const id = await seedRequest(MediaRequestStatus.APPROVED);
    const admin = await loginAs('admin@seerr.dev');
    resetSpies();

    const res = await admin
      .post(`/request/auto-delete/${id}`)
      .send({ days: 0 });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(sendToRadarr.callCount(), 0);
    assert.strictEqual(requestAfterUpdate.callCount(), 0);
    const persisted = await readRequest(id);
    assert.strictEqual(persisted.autoDeleteDays, null);
    assert.strictEqual(persisted.autoDeleteDate ?? null, null);
  });
});
