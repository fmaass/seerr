import type { RadarrMovie } from '@server/api/servarr/radarr';
import RadarrAPI from '@server/api/servarr/radarr';
import { MediaStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import type {
  RunnableScanner,
  StatusBase,
} from '@server/lib/scanners/baseScanner';
import BaseScanner from '@server/lib/scanners/baseScanner';
import type { RadarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import { uniqWith } from 'lodash';

type SyncStatus = StatusBase & {
  currentServer: RadarrSettings;
  servers: RadarrSettings[];
};

class RadarrScanner
  extends BaseScanner<RadarrMovie>
  implements RunnableScanner<SyncStatus>
{
  private servers: RadarrSettings[];
  private currentServer: RadarrSettings;
  private radarrApi: RadarrAPI;
  private scannedTmdbIds: Set<number> = new Set();
  private scanned4kTmdbIds: Set<number> = new Set();
  private didScanStandard = false;
  private didScan4k = false;

  constructor() {
    super('Radarr Scan', { bundleSize: 50 });
  }

  public status(): SyncStatus {
    return {
      running: this.running,
      progress: this.progress,
      total: this.items.length,
      currentServer: this.currentServer,
      servers: this.servers,
    };
  }

  public async run(): Promise<void> {
    const settings = getSettings();
    const sessionId = this.startRun();
    this.scannedTmdbIds.clear();
    this.scanned4kTmdbIds.clear();
    this.didScanStandard = false;
    this.didScan4k = false;

    try {
      this.servers = uniqWith(settings.radarr, (radarrA, radarrB) => {
        return (
          radarrA.hostname === radarrB.hostname &&
          radarrA.port === radarrB.port &&
          radarrA.baseUrl === radarrB.baseUrl
        );
      });

      for (const server of this.servers) {
        this.currentServer = server;
        if (server.syncEnabled) {
          this.log(
            `Beginning to process Radarr server: ${server.name}`,
            'info'
          );

          this.radarrApi = new RadarrAPI({
            apiKey: server.apiKey,
            url: RadarrAPI.buildUrl(server, '/api/v3'),
          });

          this.items = await this.radarrApi.getMovies();

          const server4k = this.enable4kMovie && server.is4k;
          if (server4k) {
            this.didScan4k = true;
          } else {
            this.didScanStandard = true;
          }

          await this.loop(this.processRadarrMovie.bind(this), { sessionId });

          // Detect movies that were in Radarr but are now missing
          await this.detectMissingMovies(server, sessionId);
        } else {
          this.log(`Sync not enabled. Skipping Radarr server: ${server.name}`);
        }
      }

      // Only run cleanup if all servers of this profile type have sync enabled.
      // If any server is skipped, we can't distinguish truly orphaned media from
      // media that exists on an unscanned server (e.g. separate instances for
      // anime, regional content, or different languages).
      const allStandardScanned = this.servers
        .filter((s) => !this.enable4kMovie || !s.is4k)
        .every((s) => s.syncEnabled);
      const all4kScanned = this.servers
        .filter((s) => this.enable4kMovie && s.is4k)
        .every((s) => s.syncEnabled);

      if (!allStandardScanned) {
        this.didScanStandard = false;
      }
      if (!all4kScanned) {
        this.didScan4k = false;
      }

      await this.cleanupOrphanedMovies();
      this.log('Radarr scan complete', 'info');
    } catch (e) {
      this.log('Scan interrupted', 'error', { errorMessage: e.message });
    } finally {
      this.endRun(sessionId);
    }
  }

  private async processRadarrMovie(radarrMovie: RadarrMovie): Promise<void> {
    const server4k = this.enable4kMovie && this.currentServer.is4k;
    if (server4k) {
      this.scanned4kTmdbIds.add(radarrMovie.tmdbId);
    } else {
      this.scannedTmdbIds.add(radarrMovie.tmdbId);
    }

    try {
      await this.processMovie(radarrMovie.tmdbId, {
        is4k: server4k,
        serviceId: this.currentServer.id,
        externalServiceId: radarrMovie.id,
        externalServiceSlug: radarrMovie.titleSlug,
        title: radarrMovie.title,
        processing: !radarrMovie.hasFile && radarrMovie.monitored,
        hasFile: radarrMovie.hasFile,
      });
    } catch (e) {
      this.log('Failed to process Radarr media', 'error', {
        errorMessage: e.message,
        title: radarrMovie.title,
      });
    }
  }

  private async cleanupOrphanedMovies(): Promise<void> {
    const mediaRepository = getRepository(Media);

    if (this.didScanStandard) {
      const processingMovies = await mediaRepository.find({
        where: { mediaType: MediaType.MOVIE, status: MediaStatus.PROCESSING },
      });

      for (const media of processingMovies) {
        if (!this.scannedTmdbIds.has(media.tmdbId)) {
          media.status = MediaStatus.UNKNOWN;
          await mediaRepository.save(media);
          this.log(
            `Movie ${media.tmdbId} not found in any Radarr server. Status reset to UNKNOWN.`,
            'info'
          );
        }
      }
    } else {
      this.log(
        'Skipping orphaned movie cleanup: no standard Radarr servers were scanned.',
        'info'
      );
    }

    if (this.didScan4k) {
      const processing4kMovies = await mediaRepository.find({
        where: {
          mediaType: MediaType.MOVIE,
          status4k: MediaStatus.PROCESSING,
        },
      });

      for (const media of processing4kMovies) {
        if (!this.scanned4kTmdbIds.has(media.tmdbId)) {
          media.status4k = MediaStatus.UNKNOWN;
          await mediaRepository.save(media);
          this.log(
            `Movie ${media.tmdbId} not found in any 4K Radarr server. 4K status reset to UNKNOWN.`,
            'info'
          );
        }
      }
    } else if (this.enable4kMovie) {
      this.log(
        'Skipping orphaned 4K movie cleanup: no 4K Radarr servers were scanned.',
        'info'
      );
    }
  }

  private async detectMissingMovies(
    server: RadarrSettings,
    sessionId: string
  ): Promise<void> {
    try {
      const { getRepository } = await import('@server/datasource');
      const Media = (await import('@server/entity/Media')).default;
      const { MediaStatus, MediaType } = await import(
        '@server/constants/media'
      );

      const mediaRepository = getRepository(Media);

      // Get all movies that have this Radarr server ID and are marked as available/processing
      const mediaInSeerr = await mediaRepository.find({
        where: {
          mediaType: MediaType.MOVIE,
          serviceId: server.id,
        },
      });

      const radarrTmdbIds = new Set(this.items.map((m) => m.tmdbId));
      let updatedCount = 0;

      for (const media of mediaInSeerr) {
        // If movie is marked as available/processing but doesn't exist in Radarr anymore
        if (
          !radarrTmdbIds.has(media.tmdbId) &&
          (media.status === MediaStatus.AVAILABLE ||
            media.status === MediaStatus.PROCESSING)
        ) {
          this.log('Detected missing movie, updating status', 'info', {
            tmdbId: media.tmdbId,
            oldStatus: media.status,
          });

          media.status = MediaStatus.UNKNOWN;
          media.serviceId = null;
          media.externalServiceId = null;
          media.externalServiceSlug = null;
          await mediaRepository.save(media);
          updatedCount++;
        }
      }

      if (updatedCount > 0) {
        this.log(`Updated status for ${updatedCount} missing movies`, 'info', {
          serverName: server.name,
        });
      }
    } catch (e) {
      this.log('Error detecting missing movies', 'error', {
        errorMessage: e.message,
      });
    }
  }
}

export const radarrScanner = new RadarrScanner();
