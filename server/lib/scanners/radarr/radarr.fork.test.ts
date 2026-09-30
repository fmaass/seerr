import type { RadarrMovie } from '@server/api/servarr/radarr';
import RadarrAPI from '@server/api/servarr/radarr';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import MediaRequest from '@server/entity/MediaRequest';
import { User } from '@server/entity/User';
import { radarrScanner } from '@server/lib/scanners/radarr';
import type { RadarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { beforeEach, describe, it, mock } from 'node:test';

let getMoviesImpl: () => Promise<RadarrMovie[]> = async () => [];
Object.defineProperty(RadarrAPI.prototype, 'getMovies', {
  set() {},
  get() {
    return async () => getMoviesImpl();
  },
  configurable: true,
});

// The targeted per-server lookup the missing-movie pass must consult before
// it resets a movie; the default models a movie absent from every server.
let lookupCalls: number[] = [];
let getLibraryMoviesByTmdbIdImpl: (
  tmdbId: number
) => Promise<RadarrMovie[]> = async () => [];
Object.defineProperty(RadarrAPI.prototype, 'getLibraryMoviesByTmdbId', {
  set() {},
  get() {
    return async (tmdbId: number) => {
      lookupCalls.push(tmdbId);
      return getLibraryMoviesByTmdbIdImpl(tmdbId);
    };
  },
  configurable: true,
});

mock.method(MediaRequest, 'sendNotification', async () => undefined);

setupTestDb();

function configureRadarr(overrides: Partial<RadarrSettings>[] = [{}]): void {
  const settings = getSettings();
  settings.radarr = overrides.map((o, i) => ({
    id: i,
    name: `Radarr ${i}`,
    hostname: 'localhost',
    port: 7878,
    apiKey: 'test-key',
    baseUrl: '',
    useSsl: false,
    activeProfileId: 1,
    activeDirectory: '/movies',
    is4k: false,
    minimumAvailability: 'released',
    tags: [],
    isDefault: i === 0,
    syncEnabled: true,
    preventSearch: false,
    externalUrl: '',
    ...o,
  })) as RadarrSettings[];
  settings.sonarr = [];
}

function fakeRadarrMovie(overrides: Partial<RadarrMovie> = {}): RadarrMovie {
  return {
    tmdbId: 550,
    id: 1,
    title: 'Test Movie',
    titleSlug: 'test-movie',
    monitored: true,
    hasFile: true,
    isAvailable: true,
    imdbId: 'tt0137523',
    folderName: '/movies/Test Movie (2024)',
    path: '/movies/Test Movie (2024)',
    profileId: 1,
    qualityProfileId: 1,
    added: '2024-01-01T00:00:00Z',
    tags: [],
    ...overrides,
  };
}

describe('Radarr Scanner (fork: missing-movie pass)', () => {
  beforeEach(() => {
    getMoviesImpl = async () => [];
    getLibraryMoviesByTmdbIdImpl = async () => [];
    lookupCalls = [];
  });

  it('T1: keeps an AVAILABLE movie and its service ids when the server returns no movies', async () => {
    const mediaRepository = getRepository(Media);

    await mediaRepository.save(
      new Media({
        tmdbId: 9001,
        mediaType: MediaType.MOVIE,
        status: MediaStatus.AVAILABLE,
        serviceId: 0,
        externalServiceId: 42,
        externalServiceSlug: 'test-movie',
      })
    );

    configureRadarr([{ syncEnabled: true }]);
    getMoviesImpl = async () => [];

    await radarrScanner.run();

    const updatedMedia = await mediaRepository.findOneOrFail({
      where: { tmdbId: 9001 },
    });

    assert.strictEqual(updatedMedia.status, MediaStatus.AVAILABLE);
    assert.strictEqual(updatedMedia.serviceId, 0);
    assert.strictEqual(updatedMedia.externalServiceId, 42);
  });

  it('T2: declines the approved request when a PROCESSING movie is missing from a non-empty response', async () => {
    const mediaRepository = getRepository(Media);
    const requestRepository = getRepository(MediaRequest);
    const userRepository = getRepository(User);

    const requestedBy = await userRepository.findOneOrFail({
      where: { id: 1 },
    });

    const media = await mediaRepository.save(
      new Media({
        tmdbId: 9002,
        mediaType: MediaType.MOVIE,
        status: MediaStatus.PROCESSING,
        serviceId: 0,
      })
    );

    const settings = getSettings();
    settings.radarr = [];
    settings.sonarr = [];
    const request = await requestRepository.save(
      new MediaRequest({
        type: MediaType.MOVIE,
        status: MediaRequestStatus.APPROVED,
        media,
        requestedBy,
        is4k: false,
      })
    );

    configureRadarr([{ syncEnabled: true }]);
    getMoviesImpl = async () => [fakeRadarrMovie({ tmdbId: 9102 })];

    await radarrScanner.run();

    const updatedMedia = await mediaRepository.findOneOrFail({
      where: { tmdbId: 9002 },
    });
    const updatedRequest = await requestRepository.findOneOrFail({
      where: { id: request.id },
    });

    assert.strictEqual(updatedMedia.status, MediaStatus.UNKNOWN);
    assert.strictEqual(updatedMedia.serviceId, null);
    assert.strictEqual(updatedRequest.status, MediaRequestStatus.DECLINED);
  });

  it('T3: still resets an AVAILABLE movie missing from a non-empty response', async () => {
    const mediaRepository = getRepository(Media);

    await mediaRepository.save(
      new Media({
        tmdbId: 9003,
        mediaType: MediaType.MOVIE,
        status: MediaStatus.AVAILABLE,
        serviceId: 0,
        externalServiceId: 42,
        externalServiceSlug: 'test-movie',
      })
    );

    configureRadarr([{ syncEnabled: true }]);
    getMoviesImpl = async () => [fakeRadarrMovie({ tmdbId: 9103 })];

    await radarrScanner.run();

    const updatedMedia = await mediaRepository.findOneOrFail({
      where: { tmdbId: 9003 },
    });

    assert.strictEqual(updatedMedia.status, MediaStatus.UNKNOWN);
    assert.strictEqual(updatedMedia.serviceId, null);
    assert.strictEqual(updatedMedia.externalServiceId, null);
  });

  it('T4: leaves a PROCESSING movie with a serviceId untouched when the server returns an empty list', async () => {
    const mediaRepository = getRepository(Media);
    const requestRepository = getRepository(MediaRequest);
    const userRepository = getRepository(User);

    const requestedBy = await userRepository.findOneOrFail({
      where: { id: 1 },
    });

    const media = await mediaRepository.save(
      new Media({
        tmdbId: 9004,
        mediaType: MediaType.MOVIE,
        status: MediaStatus.PROCESSING,
        serviceId: 0,
      })
    );

    const settings = getSettings();
    settings.radarr = [];
    settings.sonarr = [];
    const request = await requestRepository.save(
      new MediaRequest({
        type: MediaType.MOVIE,
        status: MediaRequestStatus.APPROVED,
        media,
        requestedBy,
        is4k: false,
      })
    );

    configureRadarr([{ syncEnabled: true }]);
    getMoviesImpl = async () => [];

    await radarrScanner.run();

    const updatedMedia = await mediaRepository.findOneOrFail({
      where: { tmdbId: 9004 },
    });
    const updatedRequest = await requestRepository.findOneOrFail({
      where: { id: request.id },
    });

    assert.strictEqual(updatedMedia.status, MediaStatus.PROCESSING);
    assert.strictEqual(updatedMedia.serviceId, 0);
    assert.strictEqual(updatedRequest.status, MediaRequestStatus.APPROVED);
  });

  it('T5: keeps the approved request when a movie has moved to a later Radarr server', async () => {
    const mediaRepository = getRepository(Media);
    const requestRepository = getRepository(MediaRequest);
    const userRepository = getRepository(User);

    const requestedBy = await userRepository.findOneOrFail({
      where: { id: 1 },
    });

    const media = await mediaRepository.save(
      new Media({
        tmdbId: 9005,
        mediaType: MediaType.MOVIE,
        status: MediaStatus.PROCESSING,
        serviceId: 0,
        externalServiceId: 42,
      })
    );

    const settings = getSettings();
    settings.radarr = [];
    settings.sonarr = [];
    const request = await requestRepository.save(
      new MediaRequest({
        type: MediaType.MOVIE,
        status: MediaRequestStatus.APPROVED,
        media,
        requestedBy,
        is4k: false,
      })
    );

    // Distinct ports: run() de-duplicates servers by hostname/port/baseUrl.
    configureRadarr([{ port: 7878 }, { port: 7879 }]);
    // The scan loop is sequential, so a call counter yields a per-server
    // response: server 0 no longer lists the movie, server 1 now does.
    const responses = [
      [fakeRadarrMovie({ tmdbId: 9105 })],
      [fakeRadarrMovie({ tmdbId: 9005, hasFile: false, monitored: true })],
    ];
    let call = 0;
    getMoviesImpl = async () => responses[call++] ?? [];

    await radarrScanner.run();

    const updatedMedia = await mediaRepository.findOneOrFail({
      where: { tmdbId: 9005 },
    });
    const updatedRequest = await requestRepository.findOneOrFail({
      where: { id: request.id },
    });

    assert.strictEqual(updatedMedia.status, MediaStatus.PROCESSING);
    assert.strictEqual(updatedMedia.serviceId, 1);
    assert.strictEqual(updatedRequest.status, MediaRequestStatus.APPROVED);
  });

  it('T6: still declines when the movie is missing from every Radarr server', async () => {
    const mediaRepository = getRepository(Media);
    const requestRepository = getRepository(MediaRequest);
    const userRepository = getRepository(User);

    const requestedBy = await userRepository.findOneOrFail({
      where: { id: 1 },
    });

    const media = await mediaRepository.save(
      new Media({
        tmdbId: 9006,
        mediaType: MediaType.MOVIE,
        status: MediaStatus.PROCESSING,
        serviceId: 0,
        externalServiceId: 42,
      })
    );

    const settings = getSettings();
    settings.radarr = [];
    settings.sonarr = [];
    const request = await requestRepository.save(
      new MediaRequest({
        type: MediaType.MOVIE,
        status: MediaRequestStatus.APPROVED,
        media,
        requestedBy,
        is4k: false,
      })
    );

    // Distinct ports: run() de-duplicates servers by hostname/port/baseUrl.
    configureRadarr([{ port: 7878 }, { port: 7879 }]);
    const responses = [
      [fakeRadarrMovie({ tmdbId: 9106 })],
      [fakeRadarrMovie({ tmdbId: 9206 })],
    ];
    let call = 0;
    getMoviesImpl = async () => responses[call++] ?? [];

    await radarrScanner.run();

    const updatedMedia = await mediaRepository.findOneOrFail({
      where: { tmdbId: 9006 },
    });
    const updatedRequest = await requestRepository.findOneOrFail({
      where: { id: request.id },
    });

    assert.strictEqual(updatedMedia.status, MediaStatus.UNKNOWN);
    assert.strictEqual(updatedMedia.serviceId, null);
    assert.strictEqual(updatedRequest.status, MediaRequestStatus.DECLINED);
  });

  async function seedProcessingWithRequest(tmdbId: number) {
    const mediaRepository = getRepository(Media);
    const requestRepository = getRepository(MediaRequest);
    const requestedBy = await getRepository(User).findOneOrFail({
      where: { id: 1 },
    });

    const media = await mediaRepository.save(
      new Media({
        tmdbId,
        mediaType: MediaType.MOVIE,
        status: MediaStatus.PROCESSING,
        serviceId: 0,
        externalServiceId: 42,
      })
    );

    const settings = getSettings();
    settings.radarr = [];
    settings.sonarr = [];
    const request = await requestRepository.save(
      new MediaRequest({
        type: MediaType.MOVIE,
        status: MediaRequestStatus.APPROVED,
        media,
        requestedBy,
        is4k: false,
      })
    );

    return { media, request };
  }

  it('T7: keeps a movie the targeted lookup still finds although the bulk list omitted it', async () => {
    const mediaRepository = getRepository(Media);
    const requestRepository = getRepository(MediaRequest);
    const { request } = await seedProcessingWithRequest(9007);
    await mediaRepository.save(
      new Media({
        tmdbId: 9017,
        mediaType: MediaType.MOVIE,
        status: MediaStatus.AVAILABLE,
        serviceId: 0,
        externalServiceId: 43,
      })
    );

    configureRadarr([{ syncEnabled: true }]);
    getMoviesImpl = async () => [fakeRadarrMovie({ tmdbId: 9107 })];
    getLibraryMoviesByTmdbIdImpl = async (tmdbId) => [
      fakeRadarrMovie({ tmdbId }),
    ];

    await radarrScanner.run();

    const processing = await mediaRepository.findOneOrFail({
      where: { tmdbId: 9007 },
    });
    const available = await mediaRepository.findOneOrFail({
      where: { tmdbId: 9017 },
    });
    const updatedRequest = await requestRepository.findOneOrFail({
      where: { id: request.id },
    });

    assert.strictEqual(processing.status, MediaStatus.PROCESSING);
    assert.strictEqual(processing.serviceId, 0);
    assert.strictEqual(processing.externalServiceId, 42);
    assert.strictEqual(available.status, MediaStatus.AVAILABLE);
    assert.strictEqual(available.serviceId, 0);
    assert.strictEqual(available.externalServiceId, 43);
    assert.strictEqual(updatedRequest.status, MediaRequestStatus.APPROVED);
  });

  it('T8: keeps a movie whose targeted lookup fails', async () => {
    const mediaRepository = getRepository(Media);
    const requestRepository = getRepository(MediaRequest);
    const { request } = await seedProcessingWithRequest(9008);

    configureRadarr([{ syncEnabled: true }]);
    getMoviesImpl = async () => [fakeRadarrMovie({ tmdbId: 9108 })];
    getLibraryMoviesByTmdbIdImpl = async () => {
      throw new Error('connect ECONNREFUSED');
    };

    await radarrScanner.run();

    const updatedMedia = await mediaRepository.findOneOrFail({
      where: { tmdbId: 9008 },
    });
    const updatedRequest = await requestRepository.findOneOrFail({
      where: { id: request.id },
    });

    assert.strictEqual(updatedMedia.status, MediaStatus.PROCESSING);
    assert.strictEqual(updatedMedia.serviceId, 0);
    assert.strictEqual(updatedMedia.externalServiceId, 42);
    assert.strictEqual(updatedRequest.status, MediaRequestStatus.APPROVED);
  });

  it('T9: resets and declines only after the targeted lookup confirms the movie is absent', async () => {
    const mediaRepository = getRepository(Media);
    const requestRepository = getRepository(MediaRequest);
    const { request } = await seedProcessingWithRequest(9009);

    configureRadarr([{ syncEnabled: true }]);
    getMoviesImpl = async () => [fakeRadarrMovie({ tmdbId: 9109 })];
    getLibraryMoviesByTmdbIdImpl = async () => [];

    await radarrScanner.run();

    const updatedMedia = await mediaRepository.findOneOrFail({
      where: { tmdbId: 9009 },
    });
    const updatedRequest = await requestRepository.findOneOrFail({
      where: { id: request.id },
    });

    assert.ok(lookupCalls.includes(9009));
    assert.strictEqual(updatedMedia.status, MediaStatus.UNKNOWN);
    assert.strictEqual(updatedMedia.serviceId, null);
    assert.strictEqual(updatedMedia.externalServiceId, null);
    assert.strictEqual(updatedRequest.status, MediaRequestStatus.DECLINED);
  });
});
