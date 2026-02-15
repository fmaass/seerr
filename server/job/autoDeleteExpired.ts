import RadarrAPI from '@server/api/servarr/radarr';
import SonarrAPI from '@server/api/servarr/sonarr';
import { MediaRequestStatus, MediaStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import type { RunnableScanner, StatusBase } from '@server/lib/scanners/baseScanner';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';

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
        .where('request.status = :status', {
          status: MediaRequestStatus.APPROVED,
        })
        .andWhere('request.autoDeleteDays IS NOT NULL')
        .andWhere('request.autoDeleteDays > 0')
        .andWhere('media.mediaAddedAt IS NOT NULL')
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
        logger.info('No expired media requests found (all still within retention period)', {
          label: 'Auto-Delete Job',
          candidatesChecked: candidates.length,
        });
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
          expiresAt.setDate(expiresAt.getDate() + (request.autoDeleteDays ?? 0));

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
            const radarrServer = settings.radarr.find(
              (server) =>
                server.id === request.serverId && server.is4k === request.is4k
            );

            if (!radarrServer) {
              logger.warn('Radarr server not found for expired request', {
                label: 'Auto-Delete Job',
                requestId: request.id,
                serverId: request.serverId,
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
              if (error.message?.includes('404') || error.message?.includes('not found')) {
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

            const mediaRepository = getRepository(Media);
            const media = await mediaRepository.findOne({
              where: { id: request.media.id },
            });
            if (media) {
              media.status = MediaStatus.UNKNOWN;
              media.serviceId = null;
              media.externalServiceId = null;
              media.externalServiceSlug = null;
              await mediaRepository.save(media);

              logger.info('Reset media status after auto-delete', {
                label: 'Auto-Delete Job',
                tmdbId: request.media.tmdbId,
                newStatus: 'UNKNOWN',
              });
            }
          } else if (request.type === MediaType.TV) {
            const sonarrServer = settings.sonarr.find(
              (server) =>
                server.id === request.serverId && server.is4k === request.is4k
            );

            if (!sonarrServer) {
              logger.warn('Sonarr server not found for expired request', {
                label: 'Auto-Delete Job',
                requestId: request.id,
                serverId: request.serverId,
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
              if (error.message?.includes('404') || error.message?.includes('not found')) {
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

            const mediaRepository = getRepository(Media);
            const media = await mediaRepository.findOne({
              where: { id: request.media.id },
            });
            if (media) {
              media.status = MediaStatus.UNKNOWN;
              media.serviceId = null;
              media.externalServiceId = null;
              media.externalServiceSlug = null;
              await mediaRepository.save(media);

              logger.info('Reset media status after auto-delete', {
                label: 'Auto-Delete Job',
                tmdbId: request.media.tmdbId,
                newStatus: 'UNKNOWN',
              });
            }
          }

          request.autoDeleteDays = null;
          request.autoDeleteDate = undefined;
          await requestRepository.save(request);
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
