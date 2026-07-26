import assert from 'node:assert/strict';
import { beforeEach, describe, it, mock } from 'node:test';

import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import Settings, { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { setupTestDb } from '@server/test/db';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import settingsRoutes from './settings';

mock.method(Settings.prototype, 'save', async () => undefined);

beforeEach(() => {
  getSettings().main.documentaryExemptUserIds = [];
});

setupTestDb();

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
  const layer = (settingsRoutes as unknown as RouterWithStack).stack.find(
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

async function invokeMainRoute(
  method: 'get' | 'post',
  body: Record<string, unknown> = {}
) {
  const admin = await getRepository(User).findOneOrFail({
    where: { email: 'admin@seerr.dev' },
  });
  const request = { body, user: admin } as Request;
  const { result, response } = createResponse();
  let nextError: unknown;

  await getRouteHandler('/main', method)(request, response, ((
    error?: unknown
  ) => {
    nextError = error;
  }) as NextFunction);

  assert.strictEqual(nextError, undefined);
  return result;
}

function mainBody(result: { status?: number; body?: unknown }) {
  assert.strictEqual(result.status, 200);
  return result.body as { documentaryExemptUserIds: number[] };
}

function captureWarnings() {
  const warnings: string[] = [];
  const originalWarn = logger.warn;

  logger.warn = ((message: string) => {
    warnings.push(message);
    return logger;
  }) as typeof logger.warn;

  return {
    warnings,
    restore: () => {
      logger.warn = originalWarn;
    },
  };
}

describe('POST /settings/main documentaryExemptUserIds', () => {
  it('adds exempt user ids and reflects them on the next read', async () => {
    const posted = mainBody(
      await invokeMainRoute('post', { documentaryExemptUserIds: [3, 4] })
    );

    assert.deepStrictEqual(posted.documentaryExemptUserIds, [3, 4]);
    assert.deepStrictEqual(getSettings().main.documentaryExemptUserIds, [3, 4]);

    const read = mainBody(await invokeMainRoute('get'));
    assert.deepStrictEqual(read.documentaryExemptUserIds, [3, 4]);
  });

  it('shrinks the list instead of merging index-wise', async () => {
    getSettings().main.documentaryExemptUserIds = [3, 4];

    const posted = mainBody(
      await invokeMainRoute('post', { documentaryExemptUserIds: [4] })
    );

    assert.deepStrictEqual(posted.documentaryExemptUserIds, [4]);
    assert.deepStrictEqual(getSettings().main.documentaryExemptUserIds, [4]);

    const read = mainBody(await invokeMainRoute('get'));
    assert.deepStrictEqual(read.documentaryExemptUserIds, [4]);
  });

  it('clears the list when an empty array is submitted', async () => {
    getSettings().main.documentaryExemptUserIds = [3, 4];

    const posted = mainBody(
      await invokeMainRoute('post', { documentaryExemptUserIds: [] })
    );

    assert.deepStrictEqual(posted.documentaryExemptUserIds, []);
    assert.deepStrictEqual(getSettings().main.documentaryExemptUserIds, []);

    const read = mainBody(await invokeMainRoute('get'));
    assert.deepStrictEqual(read.documentaryExemptUserIds, []);
  });

  it('normalizes numeric strings to numbers', async () => {
    const posted = mainBody(
      await invokeMainRoute('post', { documentaryExemptUserIds: ['3'] })
    );

    assert.deepStrictEqual(posted.documentaryExemptUserIds, [3]);
    const stored = getSettings().main.documentaryExemptUserIds;
    assert.deepStrictEqual(stored, [3]);
    assert.strictEqual(typeof stored[0], 'number');
  });

  it('drops non-integer and NaN entries and warns', async () => {
    const logs = captureWarnings();

    try {
      const posted = mainBody(
        await invokeMainRoute('post', {
          documentaryExemptUserIds: [3, 'abc', 4.5, 7],
        })
      );

      assert.deepStrictEqual(posted.documentaryExemptUserIds, [3, 7]);
      assert.deepStrictEqual(
        getSettings().main.documentaryExemptUserIds,
        [3, 7]
      );
      assert.ok(
        logs.warnings.some((message) =>
          message.includes('documentary exemption')
        ),
        `expected a warning about dropped ids, got ${JSON.stringify(logs.warnings)}`
      );
    } finally {
      logs.restore();
    }
  });

  it('leaves the list untouched when the property is absent', async () => {
    getSettings().main.documentaryExemptUserIds = [3, 4];

    const posted = mainBody(
      await invokeMainRoute('post', { blockDocumentaryGenre: true })
    );

    assert.deepStrictEqual(posted.documentaryExemptUserIds, [3, 4]);
    assert.deepStrictEqual(getSettings().main.documentaryExemptUserIds, [3, 4]);
  });
});
