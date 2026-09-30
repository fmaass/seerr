import RadarrAPI from '@server/api/servarr/radarr';
import SonarrAPI from '@server/api/servarr/sonarr';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import dataSource, { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import type {
  RunnableScanner,
  StatusBase,
} from '@server/lib/scanners/baseScanner';
import type { DVRSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { Brackets } from 'typeorm';

// Bot-made requests carry no serverId, so fall back to the server the media
// was found on, then to the default server for the same resolution.
function resolveServer<T extends DVRSettings>(
  servers: T[],
  request: MediaRequest
): T | undefined {
  const byId = (id: number | null | undefined) =>
    id === null || id === undefined
      ? undefined
      : servers.find(
          (server) => server.id === id && server.is4k === request.is4k
        );

  return (
    byId(request.serverId) ??
    byId(request.is4k ? request.media.serviceId4k : request.media.serviceId) ??
    servers.find((server) => server.isDefault && server.is4k === request.is4k)
  );
}

// Listeners stay off for both writes: a save() would let the request
// subscriber send an APPROVED request straight back to the arr, or announce
// a COMPLETED one as available again. The request is left COMPLETED so the
// duplicate guard admits a fresh request for the same media.
async function resetAfterDelete(request: MediaRequest): Promise<void> {
  const mediaReset = request.is4k
    ? {
        status4k: MediaStatus.UNKNOWN,
        serviceId4k: null,
        externalServiceId4k: null,
        externalServiceSlug4k: null,
      }
    : {
        status: MediaStatus.UNKNOWN,
        serviceId: null,
        externalServiceId: null,
        externalServiceSlug: null,
      };

  await dataSource.transaction(async (manager) => {
    await manager
      .createQueryBuilder()
      .update(Media)
      .set({ ...mediaReset, mediaAddedAt: () => 'NULL' })
      .where('id = :id', { id: request.media.id })
      .callListeners(false)
      .execute();

    await manager
      .createQueryBuilder()
      .update(MediaRequest)
      .set({
        status: MediaRequestStatus.COMPLETED,
        autoDeleteDays: null,
        autoDeleteDate: () => 'NULL',
      })
      .where('id = :id', { id: request.id })
      .callListeners(false)
      .execute();
  });

  logger.info('Reset media status after auto-delete', {
    label: 'Auto-Delete Job',
    requestId: request.id,
    tmdbId: request.media.tmdbId,
    is4k: request.is4k,
    newStatus: 'UNKNOWN',
  });
}

class AutoDeleteExpiredJob implements RunnableScanner<StatusBase> {
  private running = false;

  public async run(): Promise<void> {
    if (this.running) {
      logger.warn('Auto-delete expired job already running, skipping', {
        label: 'Auto-Delete Job',
      });
      return;
    }

    this.running = true;

    try {
      logger.info('Starting scheduled job: Auto-Delete Expired Media', {
        label: 'Jobs',
      });

      const requestRepository = getRepository(MediaRequest);
      const settings = getSettings();

      const candidates = await requestRepository
        .createQueryBuilder('request')
        .leftJoinAndSelect('request.media', 'media')
        .leftJoinAndSelect('request.requestedBy', 'requestedBy')
        .where('request.status IN (:...statuses)', {
          statuses: [MediaRequestStatus.APPROVED, MediaRequestStatus.COMPLETED],
        })
        .andWhere('request.autoDeleteDays IS NOT NULL')
        .andWhere('request.autoDeleteDays > 0')
        .andWhere('media.mediaAddedAt IS NOT NULL')
        .andWhere(
          new Brackets((qb) => {
            qb.where(
              '(request.is4k = :standard AND media.status = :available)'
            ).orWhere('(request.is4k = :uhd AND media.status4k = :available)');
          }),
          { standard: false, uhd: true, available: MediaStatus.AVAILABLE }
        )
        .getMany();

      if (candidates.length === 0) {
        logger.info('No auto-delete candidates found', {
          label: 'Auto-Delete Job',
        });
        this.running = false;
        return;
      }

      const now = new Date();
      const expiredRequests = candidates.filter((request: MediaRequest) => {
        const addedAt = new Date(request.media.mediaAddedAt);
        const expiresAt = new Date(addedAt);
        expiresAt.setDate(expiresAt.getDate() + (request.autoDeleteDays ?? 0));
        return expiresAt <= now;
      });

      if (expiredRequests.length === 0) {
        logger.info(
          'No expired media requests found (all still within retention period)',
          {
            label: 'Auto-Delete Job',
            candidatesChecked: candidates.length,
          }
        );
        this.running = false;
        return;
      }

      logger.info('Found expired media requests ready for deletion', {
        label: 'Auto-Delete Job',
        count: expiredRequests.length,
        candidatesChecked: candidates.length,
      });

      let deletedCount = 0;
      let errorCount = 0;

      for (const request of expiredRequests) {
        try {
          const addedAt = new Date(request.media.mediaAddedAt);
          const expiresAt = new Date(addedAt);
          expiresAt.setDate(
            expiresAt.getDate() + (request.autoDeleteDays ?? 0)
          );

          logger.info('Processing expired media request', {
            label: 'Auto-Delete Job',
            requestId: request.id,
            mediaType: request.type,
            tmdbId: request.media.tmdbId,
            autoDeleteDays: request.autoDeleteDays,
            mediaAddedAt: addedAt.toISOString(),
            expiredAt: expiresAt.toISOString(),
            is4k: request.is4k,
          });

          if (request.type === MediaType.MOVIE) {
            const radarrServer = resolveServer(settings.radarr, request);

            if (!radarrServer) {
              logger.warn('Radarr server not found for expired request', {
                label: 'Auto-Delete Job',
                requestId: request.id,
                serverId: request.serverId,
                is4k: request.is4k,
              });
              continue;
            }

            const radarr = new RadarrAPI({
              apiKey: radarrServer.apiKey,
              url: RadarrAPI.buildUrl(radarrServer, '/api/v3'),
            });

            try {
              const radarrMovie = await radarr.getMovieByTmdbId(
                request.media.tmdbId
              );

              await radarr['axios'].delete(`/movie/${radarrMovie.id}`, {
                params: {
                  deleteFiles: true,
                  addImportExclusion: false,
                },
              });

              logger.info('Successfully deleted expired movie from Radarr', {
                label: 'Auto-Delete Job',
                requestId: request.id,
                title: radarrMovie.title,
                tmdbId: request.media.tmdbId,
                radarrId: radarrMovie.id,
                serverName: radarrServer.name,
              });

              deletedCount++;
            } catch (error) {
              if (
                error.message?.includes('404') ||
                error.message?.includes('not found')
              ) {
                logger.info('Movie already removed from Radarr', {
                  label: 'Auto-Delete Job',
                  requestId: request.id,
                  tmdbId: request.media.tmdbId,
                });
                deletedCount++;
              } else {
                throw error;
              }
            }

            await resetAfterDelete(request);
          } else if (request.type === MediaType.TV) {
            const sonarrServer = resolveServer(settings.sonarr, request);

            if (!sonarrServer) {
              logger.warn('Sonarr server not found for expired request', {
                label: 'Auto-Delete Job',
                requestId: request.id,
                serverId: request.serverId,
                is4k: request.is4k,
              });
              continue;
            }

            const sonarr = new SonarrAPI({
              apiKey: sonarrServer.apiKey,
              url: SonarrAPI.buildUrl(sonarrServer, '/api/v3'),
            });

            if (!request.media.tvdbId) {
              logger.warn('No TVDB ID found for series, cannot delete', {
                label: 'Auto-Delete Job',
                requestId: request.id,
                tmdbId: request.media.tmdbId,
              });
              continue;
            }

            try {
              const sonarrSeries = await sonarr.getSeriesByTvdbId(
                request.media.tvdbId
              );

              await sonarr['axios'].delete(`/series/${sonarrSeries.id}`, {
                params: {
                  deleteFiles: true,
                  addImportExclusion: false,
                },
              });

              logger.info('Successfully deleted expired series from Sonarr', {
                label: 'Auto-Delete Job',
                requestId: request.id,
                title: sonarrSeries.title,
                tvdbId: request.media.tvdbId,
                sonarrId: sonarrSeries.id,
                serverName: sonarrServer.name,
              });

              deletedCount++;
            } catch (error) {
              if (
                error.message?.includes('404') ||
                error.message?.includes('not found')
              ) {
                logger.info('Series already removed from Sonarr', {
                  label: 'Auto-Delete Job',
                  requestId: request.id,
                  tvdbId: request.media.tvdbId,
                });
                deletedCount++;
              } else {
                throw error;
              }
            }

            await resetAfterDelete(request);
          }
        } catch (error) {
          logger.error('Error processing expired media request', {
            label: 'Auto-Delete Job',
            requestId: request.id,
            error: error.message,
          });
          errorCount++;
        }
      }

      logger.info('Completed scheduled job: Auto-Delete Expired Media', {
        label: 'Jobs',
        processedCount: expiredRequests.length,
        deletedCount,
        errorCount,
      });
    } catch (e) {
      logger.error('Error running auto-delete expired job', {
        label: 'Auto-Delete Job',
        errorMessage: e.message,
      });
    } finally {
      this.running = false;
    }
  }

  public status(): StatusBase {
    return {
      running: this.running,
      progress: 0,
      total: 0,
    };
  }

  public cancel(): void {
    this.running = false;
  }
}

const autoDeleteExpiredJob = new AutoDeleteExpiredJob();
export default autoDeleteExpiredJob;
