import assert from 'node:assert/strict';
import { beforeEach, describe, it, mock } from 'node:test';

import TheMovieDb from '@server/api/themoviedb';
import { MediaRequestStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import { MediaRequest } from '@server/entity/MediaRequest';
import { User } from '@server/entity/User';
import type { MediaRequestBody } from '@server/interfaces/api/requestInterfaces';
import { Permission } from '@server/lib/permissions';
import Settings, { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { checkUser, isAuthenticated } from '@server/middleware/auth';
import { MediaRequestSubscriber } from '@server/subscriber/MediaRequestSubscriber';
import { setupTestDb } from '@server/test/db';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import requestRoutes from './request';
import autoDeleteRoutes from './request/autoDelete';
import settingsRoutes from './settings';

const POLICY_LOG_MESSAGE = 'Auto-delete policy applied to movie request';

Object.defineProperty(TheMovieDb.prototype, 'getMovie', {
  get() {
    return async ({ movieId }: { movieId: number }) => ({
      id: movieId,
      title: `Test Movie ${movieId}`,
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
      genres: [],
      original_language: 'en',
      external_ids: { tvdb_id: tvId },
      keywords: { results: [] },
      seasons: [{ season_number: 1, episode_count: 5 }],
    });
  },
  set() {},
  configurable: true,
});

mock.method(MediaRequest, 'sendNotification', async () => undefined);
mock.method(
  MediaRequestSubscriber.prototype,
  'sendToRadarr',
  async () => undefined
);
mock.method(
  MediaRequestSubscriber.prototype,
  'sendToSonarr',
  async () => undefined
);
mock.method(Settings.prototype, 'save', async () => undefined);

type Policy = { userId: number; days: number };

beforeEach(() => {
  getSettings().main.autoDeleteUserPolicies = [];
});

setupTestDb();

function setPolicies(policies: Policy[]) {
  getSettings().main.autoDeleteUserPolicies = policies;
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

async function createRequester(email: string) {
  return createOwner(email, Permission.REQUEST | Permission.REQUEST_MOVIE);
}

async function admin() {
  return getRepository(User).findOneOrFail({
    where: { email: 'admin@seerr.dev' },
  });
}

function movieBody(
  mediaId: number,
  overrides: Partial<MediaRequestBody> = {}
): MediaRequestBody {
  return { mediaType: MediaType.MOVIE, mediaId, ...overrides };
}

async function storedDays(id: number) {
  const row = await getRepository(MediaRequest).findOneOrFail({
    where: { id },
  });
  return row.autoDeleteDays ?? null;
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

type RouterWithStack = {
  stack: {
    route?: {
      path: string;
      methods: Record<string, boolean>;
      stack: { handle: RequestHandler }[];
    };
  }[];
};

function getRouteHandler(
  router: unknown,
  path: string,
  method: string
): RequestHandler {
  const layer = (router as RouterWithStack).stack.find(
    ({ route }) => route?.path === path && route.methods[method]
  );
  const handler = layer?.route?.stack.at(-1)?.handle;
  assert.ok(handler, `missing ${method.toUpperCase()} ${path} route handler`);
  return handler;
}

async function invoke(handler: RequestHandler, request: Request) {
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
  let nextError: unknown;

  await handler(
    request,
    response as unknown as Response,
    ((error?: unknown) => {
      nextError = error;
    }) as NextFunction
  );

  assert.strictEqual(nextError, undefined);
  return result;
}

async function runMiddleware(handler: RequestHandler, request: Request) {
  let nextCalled = false;
  let nextError: unknown;

  await handler(
    request,
    {} as Response,
    ((error?: unknown) => {
      nextCalled = true;
      nextError = error;
    }) as NextFunction
  );

  assert.strictEqual(nextError, undefined);
  assert.ok(nextCalled, 'expected middleware to call next()');
}

async function postMainSettings(body: Record<string, unknown>) {
  const result = await invoke(
    getRouteHandler(settingsRoutes, '/main', 'post'),
    { body, user: await admin() } as Request
  );
  assert.strictEqual(result.status, 200);
  return result.body as { autoDeleteUserPolicies: Policy[] };
}

// Goes through the real API-key auth, so the caller is whoever X-API-User
// names and the owner is resolved by the entity's own permission check.
async function postRequestAsApiUser(userId: number, body: MediaRequestBody) {
  const apiKey = 'auto-delete-policy-test-key';
  const priorApiKey = getSettings().main.apiKey;
  getSettings().main.apiKey = apiKey;
  const headers: Record<string, string> = {
    'x-api-key': apiKey,
    'x-api-user': String(userId),
  };
  const endpointRequest = {
    body,
    path: '/request',
    session: {},
    header: (name: string) => headers[name.toLowerCase()],
  } as unknown as Request;

  try {
    await runMiddleware(checkUser as RequestHandler, endpointRequest);
    await runMiddleware(isAuthenticated(), endpointRequest);
    assert.strictEqual(endpointRequest.user?.id, userId);
    const result = await invoke(
      getRouteHandler(requestRoutes, '/', 'post'),
      endpointRequest
    );
    assert.strictEqual(result.status, 201);
    return result.body as MediaRequest;
  } finally {
    getSettings().main.apiKey = priorApiKey;
  }
}

describe('auto-delete policy at movie request creation', () => {
  it('(a) applies the owner policy when the body has no auto-delete', async () => {
    const owner = await createRequester('policy-a@seerr.dev');
    setPolicies([{ userId: owner.id, days: 30 }]);
    const logs = captureLogger();

    let created: MediaRequest;
    try {
      created = await MediaRequest.request(movieBody(701001), owner);
    } finally {
      logs.restore();
    }

    assert.strictEqual(created.autoDeleteDays, 30);
    assert.strictEqual(await storedDays(created.id), 30);
    const applied = logs.info.find((c) => c.message === POLICY_LOG_MESSAGE);
    assert.ok(applied, 'expected a policy log entry');
    assert.strictEqual(applied.meta?.userId, owner.id);
    assert.strictEqual(applied.meta?.days, 30);
  });

  it('(b) overrides a lower and a higher body value with the policy', async () => {
    const owner = await createRequester('policy-b@seerr.dev');
    setPolicies([{ userId: owner.id, days: 30 }]);

    const lower = await MediaRequest.request(
      movieBody(701002, { autoDeleteDays: 7 }),
      owner
    );
    const higher = await MediaRequest.request(
      movieBody(701003, { autoDeleteDays: 90 }),
      owner
    );

    assert.strictEqual(await storedDays(lower.id), 30);
    assert.strictEqual(await storedDays(higher.id), 30);
  });

  it('(c) keeps the body value when the owner has no policy', async () => {
    const owner = await createRequester('policy-c@seerr.dev');
    const other = await createRequester('policy-c-other@seerr.dev');
    setPolicies([{ userId: other.id, days: 30 }]);

    const withBody = await MediaRequest.request(
      movieBody(701004, { autoDeleteDays: 45 }),
      owner
    );
    const withoutBody = await MediaRequest.request(movieBody(701005), owner);

    assert.strictEqual(await storedDays(withBody.id), 45);
    assert.strictEqual(await storedDays(withoutBody.id), null);
  });

  it('(d) leaves TV requests of a policy owner untouched', async () => {
    const owner = await createOwner(
      'policy-d@seerr.dev',
      Permission.REQUEST | Permission.REQUEST_TV
    );
    setPolicies([{ userId: owner.id, days: 30 }]);

    const withBody = await MediaRequest.request(
      {
        mediaType: MediaType.TV,
        mediaId: 801001,
        seasons: [1],
        autoDeleteDays: 45,
      },
      owner
    );
    const withoutBody = await MediaRequest.request(
      { mediaType: MediaType.TV, mediaId: 801002, seasons: [1] },
      owner
    );

    assert.strictEqual(withBody.type, MediaType.TV);
    assert.strictEqual(await storedDays(withBody.id), 45);
    assert.strictEqual(await storedDays(withoutBody.id), null);
  });

  it('(f) keys on the owner: an admin creating on behalf of the policy user gets the policy', async () => {
    const owner = await createRequester('policy-f@seerr.dev');
    const caller = await admin();
    setPolicies([{ userId: owner.id, days: 30 }]);

    const created = await MediaRequest.request(
      movieBody(701006, { userId: owner.id, autoDeleteDays: 7 }),
      caller
    );

    assert.strictEqual(created.requestedBy.id, owner.id);
    assert.strictEqual(await storedDays(created.id), 30);
  });

  it("(f) keys on the owner: the admin's own policy does not follow a request made for someone else", async () => {
    const owner = await createRequester('policy-f2@seerr.dev');
    const caller = await admin();
    setPolicies([{ userId: caller.id, days: 30 }]);

    const created = await MediaRequest.request(
      movieBody(701007, { userId: owner.id, autoDeleteDays: 45 }),
      caller
    );

    assert.strictEqual(created.requestedBy.id, owner.id);
    assert.strictEqual(await storedDays(created.id), 45);
  });

  it('(f) POST /request as an admin X-API-User on behalf of the policy user applies the policy', async () => {
    const owner = await createRequester('policy-f3@seerr.dev');
    const caller = await admin();
    setPolicies([{ userId: owner.id, days: 30 }]);

    const created = await postRequestAsApiUser(
      caller.id,
      movieBody(701008, { userId: owner.id })
    );

    const saved = await getRepository(MediaRequest).findOneOrFail({
      where: { id: created.id },
      relations: { requestedBy: true },
    });
    assert.strictEqual(saved.requestedBy.id, owner.id);
    assert.strictEqual(saved.autoDeleteDays, 30);
  });

  it("(f) POST /request as the policy user's own X-API-User applies the policy", async () => {
    const owner = await createRequester('policy-f4@seerr.dev');
    setPolicies([{ userId: owner.id, days: 30 }]);

    const created = await postRequestAsApiUser(
      owner.id,
      movieBody(701009, { autoDeleteDays: 7 })
    );

    const saved = await getRepository(MediaRequest).findOneOrFail({
      where: { id: created.id },
      relations: { requestedBy: true },
    });
    assert.strictEqual(saved.requestedBy.id, owner.id);
    assert.strictEqual(saved.autoDeleteDays, 30);
  });

  it('applies the policy to concurrent requests from the same owner', async () => {
    const owner = await createRequester('policy-conc@seerr.dev');
    setPolicies([{ userId: owner.id, days: 30 }]);

    const created = await Promise.all([
      MediaRequest.request(movieBody(701010, { autoDeleteDays: 7 }), owner),
      MediaRequest.request(movieBody(701011, { autoDeleteDays: 90 }), owner),
    ]);

    assert.deepStrictEqual(
      await Promise.all(created.map((request) => storedDays(request.id))),
      [30, 30]
    );
  });
});

describe('auto-delete policy on the approve route', () => {
  async function approve(requestId: number, body: Record<string, unknown>) {
    return invoke(
      getRouteHandler(requestRoutes, '/:requestId/:status', 'post'),
      {
        params: { requestId: String(requestId), status: 'approve' },
        body,
        user: await admin(),
      } as unknown as Request
    );
  }

  it('(g) keeps the policy value when the approver sends a body auto-delete', async () => {
    const owner = await createRequester('policy-g@seerr.dev');
    const pending = await MediaRequest.request(movieBody(701101), owner);
    assert.strictEqual(pending.status, MediaRequestStatus.PENDING);
    setPolicies([{ userId: owner.id, days: 30 }]);

    const result = await approve(pending.id, { autoDeleteDays: 7 });

    assert.strictEqual(result.status, 200);
    assert.strictEqual(await storedDays(pending.id), 30);
  });

  it('(g) keeps the approver body value for an owner without a policy', async () => {
    const owner = await createRequester('policy-g2@seerr.dev');
    const pending = await MediaRequest.request(movieBody(701102), owner);

    const result = await approve(pending.id, { autoDeleteDays: 7 });

    assert.strictEqual(result.status, 200);
    assert.strictEqual(await storedDays(pending.id), 7);
  });
});

describe('auto-delete policy on POST /request/auto-delete/:requestId', () => {
  async function setAutoDelete(
    requestId: number,
    body: Record<string, unknown>
  ) {
    return invoke(
      getRouteHandler(autoDeleteRoutes, '/auto-delete/:requestId', 'post'),
      {
        params: { requestId: String(requestId) },
        body,
        user: await admin(),
      } as unknown as Request
    );
  }

  const bodies: [string, Record<string, unknown>][] = [
    ['a lower days', { days: 7 }],
    ['days: 0', { days: 0 }],
    ['days: null', { days: null }],
    ['no days', {}],
  ];

  for (const [label, body] of bodies) {
    it(`(i) ${label} leaves the policy value on a policy owner's movie`, async () => {
      const owner = await createRequester('policy-i@seerr.dev');
      const created = await MediaRequest.request(
        movieBody(701201, { autoDeleteDays: 30 }),
        owner
      );
      setPolicies([{ userId: owner.id, days: 30 }]);
      assert.strictEqual(await storedDays(created.id), 30);

      const result = await setAutoDelete(created.id, body);

      assert.strictEqual(result.status, 200);
      assert.strictEqual(await storedDays(created.id), 30);
    });
  }

  for (const [label, body] of bodies.slice(1)) {
    it(`(i) ${label} clears a no-policy owner's movie`, async () => {
      const owner = await createRequester('policy-i2@seerr.dev');
      const created = await MediaRequest.request(
        movieBody(701202, { autoDeleteDays: 45 }),
        owner
      );
      assert.strictEqual(await storedDays(created.id), 45);

      const result = await setAutoDelete(created.id, body);

      assert.strictEqual(result.status, 200);
      assert.strictEqual(await storedDays(created.id), null);
    });
  }

  it('(i) a clear that reassigns the movie to a policy user applies that policy', async () => {
    const from = await createRequester('policy-i3-from@seerr.dev');
    const to = await createRequester('policy-i3-to@seerr.dev');
    setPolicies([{ userId: to.id, days: 30 }]);
    const created = await MediaRequest.request(
      movieBody(701203, { autoDeleteDays: 45 }),
      from
    );

    const result = await setAutoDelete(created.id, { days: 0, userId: to.id });

    assert.strictEqual(result.status, 200);
    assert.strictEqual(await storedDays(created.id), 30);
  });

  it('(i) a clear that reassigns the movie away from a policy user clears it', async () => {
    const from = await createRequester('policy-i4-from@seerr.dev');
    const to = await createRequester('policy-i4-to@seerr.dev');
    const created = await MediaRequest.request(
      movieBody(701204, { autoDeleteDays: 30 }),
      from
    );
    setPolicies([{ userId: from.id, days: 30 }]);
    assert.strictEqual(await storedDays(created.id), 30);

    const result = await setAutoDelete(created.id, { days: 0, userId: to.id });

    assert.strictEqual(result.status, 200);
    assert.strictEqual(await storedDays(created.id), null);
  });

  it("(i) leaves a policy owner's TV request to the body", async () => {
    const owner = await createOwner(
      'policy-i5@seerr.dev',
      Permission.REQUEST | Permission.REQUEST_TV
    );
    const created = await MediaRequest.request(
      {
        mediaType: MediaType.TV,
        mediaId: 801101,
        seasons: [1],
        autoDeleteDays: 45,
      },
      owner
    );
    setPolicies([{ userId: owner.id, days: 30 }]);

    const result = await setAutoDelete(created.id, { days: 0 });

    assert.strictEqual(result.status, 200);
    assert.strictEqual(await storedDays(created.id), null);
  });

  it("(i) still refuses a reassignment to an unknown user on a policy owner's movie", async () => {
    const owner = await createRequester('policy-i6@seerr.dev');
    const created = await MediaRequest.request(
      movieBody(701205, { autoDeleteDays: 30 }),
      owner
    );
    setPolicies([{ userId: owner.id, days: 30 }]);
    const result: { status?: number } = {};
    const response = {
      status(status: number) {
        result.status = status;
        return response;
      },
      json() {
        return response;
      },
    };
    let nextError: { status?: number } | undefined;

    await getRouteHandler(autoDeleteRoutes, '/auto-delete/:requestId', 'post')(
      {
        params: { requestId: String(created.id) },
        body: { days: 0, userId: 99999 },
        user: await admin(),
      } as unknown as Request,
      response as unknown as Response,
      ((error?: { status?: number }) => {
        nextError = error;
      }) as NextFunction
    );

    assert.strictEqual(nextError?.status, 400);
    assert.strictEqual(result.status, undefined);
    const saved = await getRepository(MediaRequest).findOneOrFail({
      where: { id: created.id },
      relations: { requestedBy: true },
    });
    assert.strictEqual(saved.requestedBy.id, owner.id);
    assert.strictEqual(saved.autoDeleteDays, 30);
  });
});

describe('POST /settings/main autoDeleteUserPolicies', () => {
  it('(e) stores a policy for a known user and drops an unknown user id', async () => {
    const owner = await createRequester('policy-e@seerr.dev');
    const logs = captureLogger();

    let posted: { autoDeleteUserPolicies: Policy[] };
    try {
      posted = await postMainSettings({
        autoDeleteUserPolicies: [
          { userId: owner.id, days: 30 },
          { userId: 99999, days: 10 },
        ],
      });
    } finally {
      logs.restore();
    }

    const expected = [{ userId: owner.id, days: 30 }];
    assert.deepStrictEqual(posted.autoDeleteUserPolicies, expected);
    assert.deepStrictEqual(getSettings().main.autoDeleteUserPolicies, expected);
    const read = await invoke(getRouteHandler(settingsRoutes, '/main', 'get'), {
      user: await admin(),
    } as Request);
    assert.deepStrictEqual(
      (read.body as { autoDeleteUserPolicies: Policy[] })
        .autoDeleteUserPolicies,
      expected
    );
    assert.ok(
      logs.warn.some((c) => JSON.stringify(c.meta ?? {}).includes('99999')),
      'expected a warning naming the unknown user id'
    );
  });

  it('(h) drops a non-integer user id with a warning', async () => {
    const owner = await createRequester('policy-h1@seerr.dev');
    const logs = captureLogger();

    let posted: { autoDeleteUserPolicies: Policy[] };
    try {
      posted = await postMainSettings({
        autoDeleteUserPolicies: [
          { userId: owner.id + 0.5, days: 30 },
          { userId: owner.id, days: 20 },
        ],
      });
    } finally {
      logs.restore();
    }

    assert.deepStrictEqual(posted.autoDeleteUserPolicies, [
      { userId: owner.id, days: 20 },
    ]);
    assert.ok(logs.warn.length > 0, 'expected a warning for the dropped entry');
  });

  it('(h) drops days outside 1..3650 with a warning', async () => {
    const a = await createRequester('policy-h2a@seerr.dev');
    const b = await createRequester('policy-h2b@seerr.dev');
    const c = await createRequester('policy-h2c@seerr.dev');
    const d = await createRequester('policy-h2d@seerr.dev');
    const e = await createRequester('policy-h2e@seerr.dev');
    const logs = captureLogger();

    let posted: { autoDeleteUserPolicies: Policy[] };
    try {
      posted = await postMainSettings({
        autoDeleteUserPolicies: [
          { userId: a.id, days: 0 },
          { userId: b.id, days: 3651 },
          { userId: c.id, days: 1.5 },
          { userId: d.id, days: 1 },
          { userId: e.id, days: 3650 },
        ],
      });
    } finally {
      logs.restore();
    }

    assert.deepStrictEqual(posted.autoDeleteUserPolicies, [
      { userId: d.id, days: 1 },
      { userId: e.id, days: 3650 },
    ]);
    assert.ok(logs.warn.length > 0, 'expected a warning for dropped days');
  });

  it('(h) collapses a duplicate user id to its last entry with a warning', async () => {
    const owner = await createRequester('policy-h3@seerr.dev');
    const logs = captureLogger();

    let posted: { autoDeleteUserPolicies: Policy[] };
    try {
      posted = await postMainSettings({
        autoDeleteUserPolicies: [
          { userId: owner.id, days: 10 },
          { userId: owner.id, days: 60 },
        ],
      });
    } finally {
      logs.restore();
    }

    assert.deepStrictEqual(posted.autoDeleteUserPolicies, [
      { userId: owner.id, days: 60 },
    ]);
    assert.ok(logs.warn.length > 0, 'expected a warning for the duplicate');
  });

  it('(h) replaces a shorter list wholesale instead of index-merging', async () => {
    const a = await createRequester('policy-h4a@seerr.dev');
    const b = await createRequester('policy-h4b@seerr.dev');
    setPolicies([
      { userId: a.id, days: 10 },
      { userId: b.id, days: 20 },
    ]);

    const posted = await postMainSettings({
      autoDeleteUserPolicies: [{ userId: b.id, days: 40 }],
    });

    assert.deepStrictEqual(posted.autoDeleteUserPolicies, [
      { userId: b.id, days: 40 },
    ]);
  });

  it('(h) leaves the list untouched when the key is absent', async () => {
    const owner = await createRequester('policy-h5@seerr.dev');
    setPolicies([{ userId: owner.id, days: 30 }]);
    const logs = captureLogger();

    try {
      await postMainSettings({ hideAvailable: false });
    } finally {
      logs.restore();
    }

    assert.deepStrictEqual(getSettings().main.autoDeleteUserPolicies, [
      { userId: owner.id, days: 30 },
    ]);
    assert.strictEqual(logs.warn.length, 0);
  });

  it('(h) an empty list clears every policy', async () => {
    const owner = await createRequester('policy-h6@seerr.dev');
    setPolicies([{ userId: owner.id, days: 30 }]);

    const posted = await postMainSettings({ autoDeleteUserPolicies: [] });

    assert.deepStrictEqual(posted.autoDeleteUserPolicies, []);
    assert.deepStrictEqual(getSettings().main.autoDeleteUserPolicies, []);
  });
});
