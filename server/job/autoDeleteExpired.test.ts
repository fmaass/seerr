import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it, mock } from 'node:test';

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
import autoDeleteExpiredJob from '@server/job/autoDeleteExpired';
import notificationManager, { Notification } from '@server/lib/notifications';
import type { RadarrSettings, SonarrSettings } from '@server/lib/settings';
import Settings, { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { MediaRequestSubscriber } from '@server/subscriber/MediaRequestSubscriber';
import { MediaSubscriber } from '@server/subscriber/MediaSubscriber';
import { setupTestDb } from '@server/test/db';
import { UpdateQueryBuilder } from 'typeorm';

// The real subscribers stay registered on the test datasource; only their
// outbound effects are replaced, so a write that reaches them is counted.
const sendToRadarr = mock.method(
  MediaRequestSubscriber.prototype,
  'sendToRadarr',
  async () => undefined
).mock;
const sendToSonarr = mock.method(
  MediaRequestSubscriber.prototype,
  'sendToSonarr',
  async () => undefined
).mock;
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

Object.defineProperty(TheMovieDb.prototype, 'getTvShow', {
  get() {
    return async ({ tvId }: { tvId: number }) => ({
      id: tvId,
      name: `Test Show ${tvId}`,
      first_air_date: '2020-01-01',
      genres: [],
      seasons: [],
      external_ids: { tvdb_id: null },
      keywords: { results: [] },
    });
  },
  set() {},
  configurable: true,
});

function resetSpies() {
  sendToRadarr.resetCalls();
  sendToSonarr.resetCalls();
  requestAfterUpdate.resetCalls();
  mediaAfterUpdate.resetCalls();
  sendNotification.resetCalls();
}

function availabilityNotifications() {
  return sendNotification.calls.filter(
    (call) => call.arguments[0] === Notification.MEDIA_AVAILABLE
  ).length;
}

// A loopback Radarr/Sonarr answering the two calls the job makes, so the real
// API client runs and the test can see which server received the delete.
type ArrCall = { server: string; method: string; path: string };
const arrCalls: ArrCall[] = [];

type FakeArr = { name: string; port: number; server: http.Server };

function startFakeArr(name: string): Promise<FakeArr> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    arrCalls.push({
      server: name,
      method: req.method ?? '',
      path: url.pathname,
    });
    res.setHeader('Content-Type', 'application/json');

    const term = url.searchParams.get('term') ?? '';
    if (req.method === 'GET' && url.pathname === '/api/v3/movie/lookup') {
      const tmdbId = Number(term.replace('tmdb:', ''));
      res.end(JSON.stringify([{ id: 5000 + tmdbId, title: 'Movie', tmdbId }]));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/v3/series/lookup') {
      const tvdbId = Number(term.replace('tvdb:', ''));
      res.end(JSON.stringify([{ id: 7000 + tvdbId, title: 'Show', tvdbId }]));
      return;
    }
    if (req.method === 'DELETE') {
      res.end('{}');
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ name, port: (server.address() as AddressInfo).port, server });
    });
  });
}

function dvr(id: number, fake: FakeArr, is4k: boolean, isDefault: boolean) {
  return {
    id,
    name: fake.name,
    hostname: '127.0.0.1',
    port: fake.port,
    apiKey: 'test',
    useSsl: false,
    activeProfileId: 1,
    activeProfileName: 'Any',
    activeDirectory: '/data',
    tags: [],
    is4k,
    isDefault,
    syncEnabled: false,
    preventSearch: true,
    tagRequests: false,
    overrideRule: [],
  };
}

function deletesTo(server: string) {
  return arrCalls.filter((c) => c.server === server && c.method === 'DELETE');
}

function allDeletes() {
  return arrCalls.filter((c) => c.method === 'DELETE');
}

const fakes: Record<string, FakeArr> = {};
let priorRadarr: RadarrSettings[];
let priorSonarr: SonarrSettings[];

// Server ids: 0 default HD Radarr, 1 non-default HD Radarr, 2 default 4K
// Radarr, 3 non-default 4K Radarr; Sonarr 0 default HD, 1 non-default HD.
function configureServers({ withDefaults = true } = {}) {
  const settings = getSettings();
  settings.radarr = [
    dvr(0, fakes.radarrDefault, false, withDefaults),
    dvr(1, fakes.radarrOther, false, false),
    dvr(2, fakes.radarr4k, true, withDefaults),
    dvr(3, fakes.radarr4kOther, true, false),
  ] as unknown as RadarrSettings[];
  settings.sonarr = [
    dvr(0, fakes.sonarrDefault, false, withDefaults),
    dvr(1, fakes.sonarrOther, false, false),
  ] as unknown as SonarrSettings[];
}

before(async () => {
  for (const name of [
    'radarrDefault',
    'radarrOther',
    'radarr4k',
    'radarr4kOther',
    'sonarrDefault',
    'sonarrOther',
  ]) {
    fakes[name] = await startFakeArr(name);
  }
  const settings = getSettings();
  priorRadarr = settings.radarr;
  priorSonarr = settings.sonarr;
});

after(async () => {
  const settings = getSettings();
  settings.radarr = priorRadarr;
  settings.sonarr = priorSonarr;
  await Promise.all(
    Object.values(fakes).map(
      (f) =>
        new Promise<void>((resolve) => {
          // Node's keep-alive agent holds sockets open past close().
          f.server.close(() => resolve());
          f.server.closeAllConnections();
        })
    )
  );
});

setupTestDb();

beforeEach(() => {
  arrCalls.length = 0;
  configureServers();
  resetSpies();
});

const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY);

async function demoUser() {
  return getRepository(User).findOneOrFail({
    where: { email: 'demo@seerr.dev' },
  });
}

async function seed(opts: {
  tmdbId: number;
  status: MediaRequestStatus;
  addedDaysAgo: number | null;
  autoDeleteDays?: number | null;
  serverId?: number | null;
  is4k?: boolean;
  type?: MediaType;
  tvdbId?: number;
  media?: Partial<Media>;
}) {
  const type = opts.type ?? MediaType.MOVIE;
  const media = await getRepository(Media).save(
    new Media({
      mediaType: type,
      tmdbId: opts.tmdbId,
      tvdbId: opts.tvdbId,
      status: MediaStatus.AVAILABLE,
      status4k: MediaStatus.UNKNOWN,
      mediaAddedAt:
        opts.addedDaysAgo === null
          ? (null as unknown as Date)
          : daysAgo(opts.addedDaysAgo),
      ...opts.media,
    })
  );

  const created = await getRepository(MediaRequest).save(
    new MediaRequest({
      type,
      status: opts.status,
      media,
      requestedBy: await demoUser(),
      is4k: opts.is4k ?? false,
      serverId: (opts.serverId ?? null) as unknown as number,
      autoDeleteDays:
        opts.autoDeleteDays === undefined ? 30 : opts.autoDeleteDays,
    })
  );

  return { mediaId: media.id, requestId: created.id };
}

async function readMedia(id: number) {
  return getRepository(Media).findOneOrFail({ where: { id } });
}

async function readRequest(id: number) {
  return getRepository(MediaRequest).findOneOrFail({
    where: { id },
    relations: { requestedBy: true },
  });
}

describe('auto-delete job candidate filter (a)', () => {
  it('picks a COMPLETED request past its date and leaves an APPROVED one before its date', async () => {
    const past = await seed({
      tmdbId: 1001,
      status: MediaRequestStatus.COMPLETED,
      addedDaysAgo: 40,
      serverId: 0,
    });
    const early = await seed({
      tmdbId: 1002,
      status: MediaRequestStatus.APPROVED,
      addedDaysAgo: 5,
      serverId: 0,
    });

    await autoDeleteExpiredJob.run();

    assert.deepStrictEqual(
      allDeletes().map((c) => c.path),
      [`/api/v3/movie/${5000 + 1001}`]
    );
    const pastRequest = await readRequest(past.requestId);
    assert.strictEqual(pastRequest.status, MediaRequestStatus.COMPLETED);
    assert.strictEqual(pastRequest.autoDeleteDays, null);

    const earlyRequest = await readRequest(early.requestId);
    assert.strictEqual(earlyRequest.status, MediaRequestStatus.APPROVED);
    assert.strictEqual(earlyRequest.autoDeleteDays, 30);
    assert.strictEqual(
      (await readMedia(early.mediaId)).status,
      MediaStatus.AVAILABLE
    );
  });

  it('skips a request past its date whose media is not available', async () => {
    const processing = await seed({
      tmdbId: 1003,
      status: MediaRequestStatus.APPROVED,
      addedDaysAgo: 40,
      serverId: 0,
      media: { status: MediaStatus.PROCESSING },
    });
    const pending = await seed({
      tmdbId: 1004,
      status: MediaRequestStatus.PENDING,
      addedDaysAgo: 40,
      serverId: 0,
    });

    await autoDeleteExpiredJob.run();

    assert.deepStrictEqual(allDeletes(), []);
    assert.strictEqual(
      (await readRequest(processing.requestId)).autoDeleteDays,
      30
    );
    assert.strictEqual(
      (await readRequest(pending.requestId)).autoDeleteDays,
      30
    );
  });

  it('judges a 4K request by status4k, not by the standard status', async () => {
    await seed({
      tmdbId: 1005,
      status: MediaRequestStatus.APPROVED,
      addedDaysAgo: 40,
      serverId: 2,
      is4k: true,
      media: {
        status: MediaStatus.AVAILABLE,
        status4k: MediaStatus.PROCESSING,
      },
    });

    await autoDeleteExpiredJob.run();

    assert.deepStrictEqual(allDeletes(), []);
  });
});

describe('auto-delete job server resolution (b)', () => {
  it('deletes a request without serverId through media.serviceId', async () => {
    const bot = await seed({
      tmdbId: 1101,
      status: MediaRequestStatus.APPROVED,
      addedDaysAgo: 40,
      serverId: null,
      media: { serviceId: 1, externalServiceId: 42 },
    });

    await autoDeleteExpiredJob.run();

    assert.deepStrictEqual(
      deletesTo('radarrOther').map((c) => c.path),
      [`/api/v3/movie/${5000 + 1101}`]
    );
    assert.deepStrictEqual(deletesTo('radarrDefault'), []);
    const media = await readMedia(bot.mediaId);
    assert.strictEqual(media.status, MediaStatus.UNKNOWN);
    assert.strictEqual(media.serviceId, null);
  });

  it('falls back to the default server for the request is4k when neither id is set', async () => {
    await seed({
      tmdbId: 1102,
      status: MediaRequestStatus.APPROVED,
      addedDaysAgo: 40,
      serverId: null,
    });

    await autoDeleteExpiredJob.run();

    assert.deepStrictEqual(
      deletesTo('radarrDefault').map((c) => c.path),
      [`/api/v3/movie/${5000 + 1102}`]
    );
    assert.deepStrictEqual(deletesTo('radarr4k'), []);
  });

  it('prefers request.serverId over media.serviceId', async () => {
    await seed({
      tmdbId: 1103,
      status: MediaRequestStatus.APPROVED,
      addedDaysAgo: 40,
      serverId: 0,
      media: { serviceId: 1 },
    });

    await autoDeleteExpiredJob.run();

    assert.strictEqual(deletesTo('radarrDefault').length, 1);
    assert.deepStrictEqual(deletesTo('radarrOther'), []);
  });

  it('logs and skips, writing nothing, when no server resolves', async () => {
    configureServers({ withDefaults: false });
    const warns: { message: unknown; meta: Record<string, unknown> }[] = [];
    const warn = mock.method(logger, 'warn', ((...args: unknown[]) => {
      warns.push({
        message: args[0],
        meta: (args[1] ?? {}) as Record<string, unknown>,
      });
      return logger;
    }) as unknown as typeof logger.warn);

    try {
      const orphan = await seed({
        tmdbId: 1104,
        status: MediaRequestStatus.APPROVED,
        addedDaysAgo: 40,
        serverId: null,
      });

      await autoDeleteExpiredJob.run();

      assert.deepStrictEqual(allDeletes(), []);
      assert.ok(
        warns.some((w) => w.meta.requestId === orphan.requestId),
        'expected a warning naming the skipped request'
      );
      const request = await readRequest(orphan.requestId);
      assert.strictEqual(request.status, MediaRequestStatus.APPROVED);
      assert.strictEqual(request.autoDeleteDays, 30);
      const media = await readMedia(orphan.mediaId);
      assert.strictEqual(media.status, MediaStatus.AVAILABLE);
      assert.notStrictEqual(media.mediaAddedAt, null);
    } finally {
      warn.mock.restore();
    }
  });

  it('resolves a series without serverId through media.serviceId', async () => {
    const show = await seed({
      tmdbId: 1105,
      tvdbId: 81105,
      type: MediaType.TV,
      status: MediaRequestStatus.APPROVED,
      addedDaysAgo: 40,
      serverId: null,
      media: { serviceId: 1 },
    });

    await autoDeleteExpiredJob.run();

    assert.deepStrictEqual(
      deletesTo('sonarrOther').map((c) => c.path),
      [`/api/v3/series/${7000 + 81105}`]
    );
    assert.deepStrictEqual(deletesTo('sonarrDefault'), []);
    const media = await readMedia(show.mediaId);
    assert.strictEqual(media.status, MediaStatus.UNKNOWN);
    assert.strictEqual(media.mediaAddedAt, null);
    const request = await readRequest(show.requestId);
    assert.strictEqual(request.status, MediaRequestStatus.COMPLETED);
    assert.strictEqual(request.autoDeleteDays, null);
  });
});

function movieBody(mediaId: number, autoDeleteDays?: number) {
  return {
    mediaType: MediaType.MOVIE,
    mediaId,
    ...(autoDeleteDays ? { autoDeleteDays } : {}),
  } as Parameters<typeof MediaRequest.request>[0];
}

describe('auto-delete job leaves a re-requestable request (c)', () => {
  it('completes the request, clears mediaAddedAt and admits a re-request', async () => {
    const expired = await seed({
      tmdbId: 1201,
      status: MediaRequestStatus.APPROVED,
      addedDaysAgo: 40,
      serverId: 0,
      media: {
        serviceId: 0,
        externalServiceId: 99,
        externalServiceSlug: 'movie-1201',
      },
    });

    await autoDeleteExpiredJob.run();

    assert.strictEqual(deletesTo('radarrDefault').length, 1);
    const request = await readRequest(expired.requestId);
    assert.strictEqual(request.status, MediaRequestStatus.COMPLETED);
    assert.strictEqual(request.autoDeleteDays, null);
    assert.strictEqual(request.autoDeleteDate ?? null, null);
    const media = await readMedia(expired.mediaId);
    assert.strictEqual(media.status, MediaStatus.UNKNOWN);
    assert.strictEqual(media.serviceId, null);
    assert.strictEqual(media.externalServiceId, null);
    assert.strictEqual(media.externalServiceSlug, null);
    assert.strictEqual(media.mediaAddedAt, null);

    const rerequest = await MediaRequest.request(
      movieBody(1201),
      await demoUser()
    );
    resetSpies();

    assert.ok(rerequest.id > expired.requestId);
    assert.strictEqual(
      await getRepository(MediaRequest).count({
        where: { media: { id: expired.mediaId } },
      }),
      2
    );
  });
});

describe('auto-delete job after a re-request (d)', () => {
  it('deletes nothing before arrival and counts a fresh window from the new mediaAddedAt', async () => {
    const expired = await seed({
      tmdbId: 1301,
      status: MediaRequestStatus.APPROVED,
      addedDaysAgo: 40,
      serverId: 0,
    });

    await autoDeleteExpiredJob.run();
    assert.strictEqual(allDeletes().length, 1);

    const rerequest = await MediaRequest.request(
      movieBody(1301, 30),
      await demoUser()
    );
    resetSpies();
    arrCalls.length = 0;

    await autoDeleteExpiredJob.run();
    assert.deepStrictEqual(allDeletes(), []);

    // Arrival: the request is approved and the file lands one day ago.
    await getRepository(MediaRequest)
      .createQueryBuilder()
      .update()
      .set({ status: MediaRequestStatus.APPROVED, serverId: 0 })
      .where('id = :id', { id: rerequest.id })
      .callListeners(false)
      .execute();
    await getRepository(Media)
      .createQueryBuilder()
      .update()
      .set({ status: MediaStatus.AVAILABLE, mediaAddedAt: daysAgo(1) })
      .where('id = :id', { id: expired.mediaId })
      .callListeners(false)
      .execute();

    await autoDeleteExpiredJob.run();
    assert.deepStrictEqual(allDeletes(), []);
    assert.strictEqual((await readRequest(rerequest.id)).autoDeleteDays, 30);

    await getRepository(Media)
      .createQueryBuilder()
      .update()
      .set({ mediaAddedAt: daysAgo(31) })
      .where('id = :id', { id: expired.mediaId })
      .callListeners(false)
      .execute();

    await autoDeleteExpiredJob.run();
    assert.strictEqual(allDeletes().length, 1);
    const second = await readRequest(rerequest.id);
    assert.strictEqual(second.status, MediaRequestStatus.COMPLETED);
    assert.strictEqual(second.autoDeleteDays, null);
  });
});

describe('auto-delete job stays silent (e)', () => {
  it('a plain save of the fixture would notify, proving the subscribers are live', async () => {
    const fixture = await seed({
      tmdbId: 1401,
      status: MediaRequestStatus.COMPLETED,
      addedDaysAgo: 40,
      serverId: 0,
    });
    resetSpies();

    const repo = getRepository(MediaRequest);
    const request = await repo.findOneOrFail({
      where: { id: fixture.requestId },
      relations: { media: true, requestedBy: true },
    });
    request.autoDeleteDays = 14;
    await repo.save(request);

    assert.ok(requestAfterUpdate.callCount() > 0);
    assert.ok(availabilityNotifications() > 0);
  });

  it('neither sends to Radarr nor notifies availability when deleting', async () => {
    await seed({
      tmdbId: 1402,
      status: MediaRequestStatus.COMPLETED,
      addedDaysAgo: 40,
      serverId: 0,
    });
    await seed({
      tmdbId: 1403,
      status: MediaRequestStatus.APPROVED,
      addedDaysAgo: 40,
      serverId: null,
    });
    resetSpies();

    await autoDeleteExpiredJob.run();

    assert.strictEqual(allDeletes().length, 2);
    assert.strictEqual(sendToRadarr.callCount(), 0);
    assert.strictEqual(sendToSonarr.callCount(), 0);
    assert.strictEqual(availabilityNotifications(), 0);
    assert.strictEqual(sendNotification.callCount(), 0);
    assert.strictEqual(requestAfterUpdate.callCount(), 0);
    assert.strictEqual(mediaAfterUpdate.callCount(), 0);
  });
});

describe('auto-delete job on a 4K request (f)', () => {
  it('deletes on the 4K server and resets only the 4K columns', async () => {
    const uhd = await seed({
      tmdbId: 1501,
      status: MediaRequestStatus.APPROVED,
      addedDaysAgo: 40,
      serverId: 2,
      is4k: true,
      media: {
        status: MediaStatus.AVAILABLE,
        status4k: MediaStatus.AVAILABLE,
        serviceId: 0,
        serviceId4k: 2,
        externalServiceId: 11,
        externalServiceId4k: 22,
        externalServiceSlug: 'hd-slug',
        externalServiceSlug4k: 'uhd-slug',
      },
    });

    await autoDeleteExpiredJob.run();

    assert.deepStrictEqual(
      deletesTo('radarr4k').map((c) => c.path),
      [`/api/v3/movie/${5000 + 1501}`]
    );
    assert.deepStrictEqual(deletesTo('radarrDefault'), []);

    const media = await readMedia(uhd.mediaId);
    assert.strictEqual(media.status4k, MediaStatus.UNKNOWN);
    assert.strictEqual(media.serviceId4k, null);
    assert.strictEqual(media.externalServiceId4k, null);
    assert.strictEqual(media.externalServiceSlug4k, null);
    assert.strictEqual(media.status, MediaStatus.AVAILABLE);
    assert.strictEqual(media.serviceId, 0);
    assert.strictEqual(media.externalServiceId, 11);
    assert.strictEqual(media.externalServiceSlug, 'hd-slug');
    assert.strictEqual(media.mediaAddedAt, null);

    const request = await readRequest(uhd.requestId);
    assert.strictEqual(request.status, MediaRequestStatus.COMPLETED);
    assert.strictEqual(request.autoDeleteDays, null);
  });

  it('resolves a 4K request without serverId through media.serviceId4k', async () => {
    await seed({
      tmdbId: 1502,
      status: MediaRequestStatus.APPROVED,
      addedDaysAgo: 40,
      serverId: null,
      is4k: true,
      media: {
        status4k: MediaStatus.AVAILABLE,
        serviceId: 1,
        serviceId4k: 3,
      },
    });

    await autoDeleteExpiredJob.run();

    assert.strictEqual(deletesTo('radarr4kOther').length, 1);
    assert.deepStrictEqual(deletesTo('radarr4k'), []);
    assert.deepStrictEqual(deletesTo('radarrOther'), []);
  });
});

describe('auto-delete job failure and overlap', () => {
  it('rolls the media reset back when the request write fails', async () => {
    const victim = await seed({
      tmdbId: 1601,
      status: MediaRequestStatus.APPROVED,
      addedDaysAgo: 40,
      serverId: 0,
      media: { serviceId: 0, externalServiceId: 16 },
    });
    const original = UpdateQueryBuilder.prototype.execute;
    const failing = mock.method(
      UpdateQueryBuilder.prototype,
      'execute',
      async function (this: UpdateQueryBuilder<object>) {
        if (this.expressionMap.mainAlias?.target === MediaRequest) {
          throw new Error('request write failed');
        }
        return original.call(this);
      }
    );

    try {
      await autoDeleteExpiredJob.run();
    } finally {
      failing.mock.restore();
    }

    assert.strictEqual(allDeletes().length, 1);
    const media = await readMedia(victim.mediaId);
    assert.strictEqual(media.status, MediaStatus.AVAILABLE);
    assert.strictEqual(media.serviceId, 0);
    assert.strictEqual(media.externalServiceId, 16);
    assert.notStrictEqual(media.mediaAddedAt, null);
    const request = await readRequest(victim.requestId);
    assert.strictEqual(request.status, MediaRequestStatus.APPROVED);
    assert.strictEqual(request.autoDeleteDays, 30);
  });

  it('deletes once when two runs overlap', async () => {
    const victim = await seed({
      tmdbId: 1602,
      status: MediaRequestStatus.APPROVED,
      addedDaysAgo: 40,
      serverId: 0,
    });

    await Promise.all([autoDeleteExpiredJob.run(), autoDeleteExpiredJob.run()]);

    assert.strictEqual(allDeletes().length, 1);
    assert.strictEqual(
      (await readRequest(victim.requestId)).status,
      MediaRequestStatus.COMPLETED
    );
  });
});
