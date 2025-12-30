import RadarrAPI from '@server/api/servarr/radarr';
import SonarrAPI from '@server/api/servarr/sonarr';
import { MediaRequestStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import { Blacklist } from '@server/entity/Blacklist';
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

      // Find all approved/completed requests with expired autoDeleteDate
      const expiredRequests = await requestRepository
        .createQueryBuilder('request')
        .leftJoinAndSelect('request.media', 'media')
        .leftJoinAndSelect('request.requestedBy', 'requestedBy')
        .where('request.status IN (:...statuses)', {
          statuses: [MediaRequestStatus.APPROVED, MediaRequestStatus.COMPLETED],
        })
        .andWhere('request.autoDeleteDate IS NOT NULL')
        .andWhere('request.autoDeleteDate <= :now', {
          now: new Date(),
        })
        .getMany();

      if (expiredRequests.length === 0) {
        logger.info('No expired media requests found', {
          label: 'Auto-Delete Job',
        });
        this.running = false;
        return;
      }

      logger.info('Found expired media requests', {
        label: 'Auto-Delete Job',
        count: expiredRequests.length,
      });

      let deletedCount = 0;
      let errorCount = 0;

      // Process each expired request
      for (const request of expiredRequests) {
        try {
          const mediaTitle =
            request.type === MediaType.MOVIE
              ? `Movie: ${request.media.tmdbId}`
              : `Series: ${request.media.tmdbId}`;

          logger.info('Processing expired media request', {
            label: 'Auto-Delete Job',
            requestId: request.id,
            mediaType: request.type,
            tmdbId: request.media.tmdbId,
            expirationDate: request.autoDeleteDate,
            is4k: request.is4k,
          });

          // Delete from Radarr or Sonarr
          if (request.type === MediaType.MOVIE) {
            // Find Radarr server
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

            // Get movie from Radarr
            let movieTitle = `TMDB ${request.media.tmdbId}`;
            try {
              const radarrMovie = await radarr.getMovieByTmdbId(
                request.media.tmdbId
              );
              movieTitle = radarrMovie.title;

              // Delete the movie
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
                expirationDate: request.autoDeleteDate,
              });

              deletedCount++;
            } catch (error) {
              if (error.message.includes('404') || error.message.includes('not found')) {
                logger.info('Movie already removed from Radarr', {
                  label: 'Auto-Delete Job',
                  requestId: request.id,
                  tmdbId: request.media.tmdbId,
                });
                // Still count as success since it's gone
                deletedCount++;
              } else {
                throw error;
              }
            }

            // Add to blocklist AFTER deletion (regardless of whether movie was found)
            // This prevents automatic re-requesting by list sync jobs
            try {
              await Blacklist.addToBlacklist({
                blacklistRequest: {
                  tmdbId: request.media.tmdbId,
                  mediaType: MediaType.MOVIE,
                  title: movieTitle,
                  blacklistedTags: 'auto-deleted',
                },
              });

              logger.info('Added auto-deleted movie to blocklist', {
                label: 'Auto-Delete Job',
                tmdbId: request.media.tmdbId,
                title: movieTitle,
              });
            } catch (blocklistError) {
              logger.warn('Failed to add to blocklist (may already exist)', {
                label: 'Auto-Delete Job',
                tmdbId: request.media.tmdbId,
                error: blocklistError.message,
              });
            }
          } else if (request.type === MediaType.TV) {
            // Find Sonarr server
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

            // Get series from Sonarr (requires TVDB ID)
            if (!request.media.tvdbId) {
              logger.warn('No TVDB ID found for series, cannot delete', {
                label: 'Auto-Delete Job',
                requestId: request.id,
                tmdbId: request.media.tmdbId,
              });
              continue;
            }

            let seriesTitle = `TMDB ${request.media.tmdbId}`;
            try {
              const sonarrSeries = await sonarr.getSeriesByTvdbId(
                request.media.tvdbId
              );
              seriesTitle = sonarrSeries.title;

              // Delete the series
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
                expirationDate: request.autoDeleteDate,
              });

              deletedCount++;
            } catch (error) {
              if (error.message.includes('404') || error.message.includes('not found')) {
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

            // Add to blocklist AFTER deletion (regardless of whether series was found)
            // This prevents automatic re-requesting by list sync jobs
            try {
              await Blacklist.addToBlacklist({
                blacklistRequest: {
                  tmdbId: request.media.tmdbId,
                  mediaType: MediaType.TV,
                  title: seriesTitle,
                  blacklistedTags: 'auto-deleted',
                },
              });

              logger.info('Added auto-deleted series to blocklist', {
                label: 'Auto-Delete Job',
                tmdbId: request.media.tmdbId,
                title: seriesTitle,
              });
            } catch (blocklistError) {
              logger.warn('Failed to add to blocklist (may already exist)', {
                label: 'Auto-Delete Job',
                tmdbId: request.media.tmdbId,
                error: blocklistError.message,
              });
            }
          }

          // Update request - mark as expired/completed (keep for history)
          // Don't delete the request itself, just clear the autoDeleteDate
          request.autoDeleteDate = null as any;
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

