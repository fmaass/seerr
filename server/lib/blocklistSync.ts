import RadarrAPI from '@server/api/servarr/radarr';
import type { RadarrImportExclusion } from '@server/api/servarr/radarr';
import SonarrAPI from '@server/api/servarr/sonarr';
import type { SonarrImportExclusion } from '@server/api/servarr/sonarr';
import TheMovieDb from '@server/api/themoviedb';
import { MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import { Blocklist } from '@server/entity/Blocklist';
import Media from '@server/entity/Media';
import {
  getSettings,
  type RadarrSettings,
  type SonarrSettings,
} from '@server/lib/settings';
import logger from '@server/logger';
import { uniqWith } from 'lodash';

export interface SyncResult {
  serverName: string;
  serverId: number;
  added: number;
  updated: number;
  removed: number;
  errors: number;
  total: number;
}

export interface SyncStats {
  totalServers: number;
  totalItems: number;
  totalAdded: number;
  totalUpdated: number;
  totalRemoved: number;
  totalErrors: number;
}

class BlocklistSyncService {
  /**
   * Remove a blocklist entry AND its associated Media entry.
   * Mirrors the upstream DELETE /blocklist/:id route behavior.
   */
  private async removeBlocklistEntry(
    item: Blocklist,
    blocklistRepository: ReturnType<typeof getRepository<Blocklist>>
  ): Promise<void> {
    await blocklistRepository.remove(item);

    // Also clean up the associated Media entry (v3 couples Blocklist + Media)
    try {
      const mediaRepository = getRepository(Media);
      const mediaItem = await mediaRepository.findOne({
        where: { tmdbId: item.tmdbId },
      });
      if (mediaItem) {
        await mediaRepository.remove(mediaItem);
      }
    } catch (e) {
      // Media cleanup is best-effort; the blocklist entry is already removed
      logger.debug('Could not clean up Media entry for removed blocklist item', {
        label: 'Blocklist Sync',
        tmdbId: item.tmdbId,
        errorMessage: e.message,
      });
    }
  }

  public async syncAllRadarrServers(): Promise<SyncStats> {
    const settings = getSettings();
    const stats: SyncStats = {
      totalServers: 0,
      totalItems: 0,
      totalAdded: 0,
      totalUpdated: 0,
      totalRemoved: 0,
      totalErrors: 0,
    };

    const radarrServers = uniqWith(
      settings.radarr.filter(
        (server) =>
          server.syncEnabled !== false &&
          (settings.main.blocklistSyncEnabled !== false) &&
          (server.blocklistSyncEnabled !== false)
      ),
      (radarrA, radarrB) =>
        radarrA.hostname === radarrB.hostname &&
        radarrA.port === radarrB.port &&
        radarrA.baseUrl === radarrB.baseUrl
    );

    if (radarrServers.length === 0) {
      logger.debug('No Radarr servers configured for blocklist sync', {
        label: 'Blocklist Sync',
      });
      return stats;
    }

    stats.totalServers = radarrServers.length;

    for (const server of radarrServers) {
      try {
        const result = await this.syncRadarrServer(server);
        stats.totalItems += result.total;
        stats.totalAdded += result.added;
        stats.totalUpdated += result.updated;
        stats.totalRemoved += result.removed;
        stats.totalErrors += result.errors;
      } catch (e) {
        logger.error('Error syncing Radarr server blocklist', {
          label: 'Blocklist Sync',
          serverName: server.name,
          serverId: server.id,
          errorMessage: e.message,
        });
        stats.totalErrors++;
      }
    }

    logger.info('Blocklist sync completed', {
      label: 'Blocklist Sync',
      stats,
    });

    return stats;
  }

  public async syncRadarrServer(server: RadarrSettings): Promise<SyncResult> {
    const result: SyncResult = {
      serverName: server.name,
      serverId: server.id,
      added: 0,
      updated: 0,
      removed: 0,
      errors: 0,
      total: 0,
    };

    try {
      logger.debug('Starting blocklist sync for Radarr server', {
        label: 'Blocklist Sync',
        serverName: server.name,
        serverId: server.id,
      });

      const radarrAPI = new RadarrAPI({
        apiKey: server.apiKey,
        url: RadarrAPI.buildUrl(server, '/api/v3'),
      });

      const exclusions = await radarrAPI.getImportExclusions();
      result.total = exclusions.length;

      if (!Array.isArray(exclusions)) {
        logger.error('Radarr returned unexpected exclusions format', {
          label: 'Blocklist Sync',
          serverName: server.name,
          serverId: server.id,
          exclusions,
        });
        result.errors = 1;
        return result;
      }

      const blocklistRepository = getRepository(Blocklist);

      if (exclusions.length === 0) {
        const syncedItems = await blocklistRepository
          .createQueryBuilder('blocklist')
          .where('blocklist.mediaType = :mediaType', {
            mediaType: MediaType.MOVIE,
          })
          .andWhere('blocklist.blocklistedTags LIKE :tagPattern', {
            tagPattern: `radarr-sync-${server.id}-%`,
          })
          .getMany();

        logger.debug('Radarr has no exclusions, checking for stale radarr-sync entries', {
          label: 'Blocklist Sync',
          serverName: server.name,
          syncedItemsCount: syncedItems.length,
        });

        for (const item of syncedItems) {
          if (item.blocklistedTags?.startsWith(`radarr-sync-${server.id}-`)) {
            try {
              await this.removeBlocklistEntry(item, blocklistRepository);
              result.removed++;
              logger.info('Removed radarr-sync entry (Radarr has no exclusions)', {
                label: 'Blocklist Sync',
                serverName: server.name,
                tmdbId: item.tmdbId,
                title: item.title,
              });
            } catch (e) {
              logger.warn('Failed to remove movie from blocklist', {
                label: 'Blocklist Sync',
                serverName: server.name,
                tmdbId: item.tmdbId,
                errorMessage: e.message,
              });
              result.errors++;
            }
          }
        }

        logger.debug('No exclusions found in Radarr server', {
          label: 'Blocklist Sync',
          serverName: server.name,
          serverId: server.id,
        });
        return result;
      }

      const currentTmdbIds = new Set(
        exclusions.map((exclusion) => exclusion.tmdbId)
      );

      for (const exclusion of exclusions) {
        try {
          const wasNew = await this.syncMovie(
            exclusion,
            blocklistRepository,
            server.id
          );
          if (wasNew) {
            result.added++;
          } else {
            result.updated++;
          }
        } catch (e) {
          logger.warn('Failed to sync movie to blocklist', {
            label: 'Blocklist Sync',
            serverName: server.name,
            serverId: server.id,
            tmdbId: exclusion.tmdbId,
            errorMessage: e.message,
          });
          result.errors++;
        }
      }

      const syncedItems = await blocklistRepository
        .createQueryBuilder('blocklist')
        .where('blocklist.mediaType = :mediaType', {
          mediaType: MediaType.MOVIE,
        })
        .andWhere('blocklist.blocklistedTags LIKE :tagPattern', {
          tagPattern: `radarr-sync-${server.id}-%`,
        })
        .getMany();

      logger.debug('Checking for stale radarr-sync entries', {
        label: 'Blocklist Sync',
        serverName: server.name,
        syncedItemsCount: syncedItems.length,
        currentExclusionsCount: currentTmdbIds.size,
      });

      for (const item of syncedItems) {
        if (!item.blocklistedTags?.startsWith(`radarr-sync-${server.id}-`)) {
          logger.warn('Skipping removal - not a radarr-sync entry', {
            label: 'Blocklist Sync',
            tmdbId: item.tmdbId,
            title: item.title,
            tags: item.blocklistedTags,
          });
          continue;
        }

        if (!currentTmdbIds.has(item.tmdbId)) {
          try {
            await this.removeBlocklistEntry(item, blocklistRepository);
            result.removed++;
            logger.info('Removed radarr-sync entry from blocklist (no longer in Radarr)', {
              label: 'Blocklist Sync',
              serverName: server.name,
              serverId: server.id,
              tmdbId: item.tmdbId,
              title: item.title,
              tags: item.blocklistedTags,
            });
          } catch (e) {
            logger.warn('Failed to remove movie from blocklist', {
              label: 'Blocklist Sync',
              serverName: server.name,
              serverId: server.id,
              tmdbId: item.tmdbId,
              errorMessage: e.message,
            });
            result.errors++;
          }
        }
      }

      logger.info('Blocklist sync completed for Radarr server', {
        label: 'Blocklist Sync',
        serverName: server.name,
        serverId: server.id,
        result,
      });

      return result;
    } catch (e) {
      logger.error('Error syncing Radarr server blocklist', {
        label: 'Blocklist Sync',
        serverName: server.name,
        serverId: server.id,
        errorMessage: e.message,
      });
      result.errors = result.total;
      return result;
    }
  }

  /**
   * Sync a single movie exclusion to Seerr blocklist.
   * Uses Blocklist.addToBlocklist() to ensure proper Media entity linkage
   * (v3 requires Blocklist + Media entries to be coupled).
   */
  private async syncMovie(
    exclusion: RadarrImportExclusion,
    blocklistRepository: ReturnType<typeof getRepository<Blocklist>>,
    serverId: number
  ): Promise<boolean> {
    // Unique constraint is on tmdbId alone, so query without mediaType
    const existing = await blocklistRepository.findOne({
      where: {
        tmdbId: exclusion.tmdbId,
      },
    });

    if (existing) {
      const expectedTag = `radarr-sync-${serverId}-${exclusion.tmdbId}`;
      if (existing.blocklistedTags !== expectedTag) {
        existing.blocklistedTags = expectedTag;
        await blocklistRepository.save(existing);
      }
      return false;
    }

    // Use the v3 static method to properly create both Blocklist + Media entries
    await Blocklist.addToBlocklist({
      blocklistRequest: {
        tmdbId: exclusion.tmdbId,
        mediaType: MediaType.MOVIE,
        title: exclusion.movieTitle || `TMDB ${exclusion.tmdbId}`,
        blocklistedTags: `radarr-sync-${serverId}-${exclusion.tmdbId}`,
      },
    });

    logger.info('Added movie to blocklist from Radarr exclusion', {
      label: 'Blocklist Sync',
      tmdbId: exclusion.tmdbId,
      title: exclusion.movieTitle,
      serverId,
    });

    return true;
  }

  public async syncAllSonarrServers(): Promise<SyncStats> {
    const settings = getSettings();
    const stats: SyncStats = {
      totalServers: 0,
      totalItems: 0,
      totalAdded: 0,
      totalUpdated: 0,
      totalRemoved: 0,
      totalErrors: 0,
    };

    const sonarrServers = uniqWith(
      settings.sonarr.filter(
        (server) =>
          server.syncEnabled !== false &&
          (settings.main.blocklistSyncEnabled !== false) &&
          (server.blocklistSyncEnabled !== false)
      ),
      (sonarrA, sonarrB) =>
        sonarrA.hostname === sonarrB.hostname &&
        sonarrA.port === sonarrB.port &&
        sonarrA.baseUrl === sonarrB.baseUrl
    );

    if (sonarrServers.length === 0) {
      logger.debug('No Sonarr servers configured for blocklist sync', {
        label: 'Blocklist Sync',
      });
      return stats;
    }

    stats.totalServers = sonarrServers.length;

    for (const server of sonarrServers) {
      try {
        const result = await this.syncSonarrServer(server);
        stats.totalItems += result.total;
        stats.totalAdded += result.added;
        stats.totalUpdated += result.updated;
        stats.totalRemoved += result.removed;
        stats.totalErrors += result.errors;
      } catch (e) {
        logger.error('Error syncing Sonarr server blocklist', {
          label: 'Blocklist Sync',
          serverName: server.name,
          serverId: server.id,
          errorMessage: e.message,
        });
        stats.totalErrors++;
      }
    }

    logger.info('Sonarr blocklist sync completed', {
      label: 'Blocklist Sync',
      stats,
    });

    return stats;
  }

  public async syncSonarrServer(server: SonarrSettings): Promise<SyncResult> {
    const result: SyncResult = {
      serverName: server.name,
      serverId: server.id,
      added: 0,
      updated: 0,
      removed: 0,
      errors: 0,
      total: 0,
    };

    try {
      logger.debug('Starting blocklist sync for Sonarr server', {
        label: 'Blocklist Sync',
        serverName: server.name,
        serverId: server.id,
      });

      const sonarrAPI = new SonarrAPI({
        apiKey: server.apiKey,
        url: SonarrAPI.buildUrl(server, '/api/v3'),
      });

      const exclusions = await sonarrAPI.getImportExclusions();
      result.total = exclusions.length;

      if (!Array.isArray(exclusions)) {
        logger.error('Sonarr returned unexpected exclusions format', {
          label: 'Blocklist Sync',
          serverName: server.name,
          serverId: server.id,
        });
        result.errors = 1;
        return result;
      }

      const blocklistRepository = getRepository(Blocklist);

      if (exclusions.length === 0) {
        const syncedItems = await blocklistRepository
          .createQueryBuilder('blocklist')
          .where('blocklist.mediaType = :mediaType', {
            mediaType: MediaType.TV,
          })
          .andWhere('blocklist.blocklistedTags LIKE :tagPattern', {
            tagPattern: `sonarr-sync-${server.id}-%`,
          })
          .getMany();

        for (const item of syncedItems) {
          if (item.blocklistedTags?.startsWith(`sonarr-sync-${server.id}-`)) {
            try {
              await this.removeBlocklistEntry(item, blocklistRepository);
              result.removed++;
              logger.info('Removed sonarr-sync entry (Sonarr has no exclusions)', {
                label: 'Blocklist Sync',
                serverName: server.name,
                tmdbId: item.tmdbId,
                title: item.title,
              });
            } catch (e) {
              logger.warn('Failed to remove TV show from blocklist', {
                label: 'Blocklist Sync',
                serverName: server.name,
                tmdbId: item.tmdbId,
                errorMessage: e.message,
              });
              result.errors++;
            }
          }
        }

        return result;
      }

      // Build a set of exclusion IDs for stale entry detection
      const currentExclusionIds = new Set(
        exclusions.map((e) => e.id)
      );

      for (const exclusion of exclusions) {
        try {
          const wasNew = await this.syncTvShow(
            exclusion,
            blocklistRepository,
            server.id
          );
          if (wasNew === true) {
            result.added++;
          } else if (wasNew === false) {
            result.updated++;
          }
          // wasNew === null means unresolvable (skipped)
        } catch (e) {
          logger.warn('Failed to sync TV show to blocklist', {
            label: 'Blocklist Sync',
            serverName: server.name,
            serverId: server.id,
            tvdbId: exclusion.tvdbId,
            title: exclusion.title,
            errorMessage: e.message,
          });
          result.errors++;
        }
      }

      // Remove stale sonarr-sync entries no longer in Sonarr
      const syncedItems = await blocklistRepository
        .createQueryBuilder('blocklist')
        .where('blocklist.mediaType = :mediaType', {
          mediaType: MediaType.TV,
        })
        .andWhere('blocklist.blocklistedTags LIKE :tagPattern', {
          tagPattern: `sonarr-sync-${server.id}-%`,
        })
        .getMany();

      for (const item of syncedItems) {
        if (!item.blocklistedTags?.startsWith(`sonarr-sync-${server.id}-`)) {
          continue;
        }

        // Extract the exclusion ID from the tag: sonarr-sync-{serverId}-{exclusionId}
        const tagParts = item.blocklistedTags.split('-');
        const exclusionId = parseInt(tagParts[tagParts.length - 1], 10);

        if (!isNaN(exclusionId) && !currentExclusionIds.has(exclusionId)) {
          try {
            await this.removeBlocklistEntry(item, blocklistRepository);
            result.removed++;
            logger.info('Removed sonarr-sync entry from blocklist (no longer in Sonarr)', {
              label: 'Blocklist Sync',
              serverName: server.name,
              serverId: server.id,
              tmdbId: item.tmdbId,
              title: item.title,
              tags: item.blocklistedTags,
            });
          } catch (e) {
            logger.warn('Failed to remove TV show from blocklist', {
              label: 'Blocklist Sync',
              serverName: server.name,
              serverId: server.id,
              tmdbId: item.tmdbId,
              errorMessage: e.message,
            });
            result.errors++;
          }
        }
      }

      logger.info('Blocklist sync completed for Sonarr server', {
        label: 'Blocklist Sync',
        serverName: server.name,
        serverId: server.id,
        result,
      });

      return result;
    } catch (e) {
      logger.error('Error syncing Sonarr server blocklist', {
        label: 'Blocklist Sync',
        serverName: server.name,
        serverId: server.id,
        errorMessage: e.message,
      });
      result.errors = result.total;
      return result;
    }
  }

  /**
   * Sync a single Sonarr exclusion to Seerr blocklist.
   * Resolves TVDB ID to TMDB ID via TMDB API.
   * Returns true if new, false if updated, null if unresolvable.
   */
  private async syncTvShow(
    exclusion: SonarrImportExclusion,
    blocklistRepository: ReturnType<typeof getRepository<Blocklist>>,
    serverId: number
  ): Promise<boolean | null> {
    const expectedTag = `sonarr-sync-${serverId}-${exclusion.id}`;

    // Resolve TVDB → TMDB
    const tmdb = new TheMovieDb();
    let tmdbId: number;

    try {
      const extResponse = await tmdb.getByExternalId({
        externalId: exclusion.tvdbId,
        type: 'tvdb',
      });

      if (!extResponse.tv_results || extResponse.tv_results.length === 0) {
        logger.debug('Could not resolve TVDB ID to TMDB — skipping exclusion', {
          label: 'Blocklist Sync',
          tvdbId: exclusion.tvdbId,
          title: exclusion.title,
        });
        return null;
      }

      tmdbId = extResponse.tv_results[0].id;
    } catch (e) {
      logger.debug('TMDB lookup failed for Sonarr exclusion — skipping', {
        label: 'Blocklist Sync',
        tvdbId: exclusion.tvdbId,
        title: exclusion.title,
        errorMessage: e.message,
      });
      return null;
    }

    const existing = await blocklistRepository.findOne({
      where: { tmdbId },
    });

    if (existing) {
      if (existing.blocklistedTags !== expectedTag) {
        existing.blocklistedTags = expectedTag;
        await blocklistRepository.save(existing);
      }
      return false;
    }

    await Blocklist.addToBlocklist({
      blocklistRequest: {
        tmdbId,
        mediaType: MediaType.TV,
        title: exclusion.title || `TVDB ${exclusion.tvdbId}`,
        blocklistedTags: expectedTag,
      },
    });

    logger.info('Added TV show to blocklist from Sonarr exclusion', {
      label: 'Blocklist Sync',
      tmdbId,
      tvdbId: exclusion.tvdbId,
      title: exclusion.title,
      serverId,
    });

    return true;
  }

  public async enforceRadarrBlocklist(): Promise<SyncStats> {
    logger.info('Enforcing blocklist on Radarr', {
      label: 'Blocklist Enforce',
    });

    const settings = getSettings();
    const stats: SyncStats = {
      totalServers: 0,
      totalItems: 0,
      totalAdded: 0,
      totalUpdated: 0,
      totalRemoved: 0,
      totalErrors: 0,
    };

    const radarrServers = uniqWith(
      settings.radarr.filter(
        (server) =>
          server.syncEnabled !== false &&
          server.blocklistEnforceEnabled === true
      ),
      (a, b) =>
        a.hostname === b.hostname &&
        a.port === b.port &&
        a.baseUrl === b.baseUrl
    );

    if (radarrServers.length === 0) {
      logger.debug('No Radarr servers configured with enforcement enabled', {
        label: 'Blocklist Enforce',
      });
      return stats;
    }

    stats.totalServers = radarrServers.length;

    for (const server of radarrServers) {
      try {
        const radarr = new RadarrAPI({
          apiKey: server.apiKey,
          url: RadarrAPI.buildUrl(server, '/api/v3'),
        });

        const exclusions = await radarr.getImportExclusions();
        
        logger.info('Enforcing Radarr exclusions on library', {
          label: 'Blocklist Enforce',
          serverName: server.name,
          exclusionCount: exclusions.length,
        });

        const excludedTmdbIds = new Set(
          exclusions.map((exclusion) => exclusion.tmdbId)
        );

        const radarrMovies = await radarr.getMovies();
        let removedCount = 0;

        for (const movie of radarrMovies) {
          if (movie.tmdbId && excludedTmdbIds.has(movie.tmdbId)) {
            const movieSize = movie.movieFile?.size || 0;
            const sizeMB = (movieSize / 1024 / 1024).toFixed(2);
            const addedDate = new Date(movie.added);
            const hoursSinceAdded = (Date.now() - addedDate.getTime()) / 1000 / 60 / 60;

            try {
              logger.warn('Removing blocklisted movie from Radarr', {
                label: 'Blocklist Enforce',
                serverName: server.name,
                title: movie.title,
                tmdbId: movie.tmdbId,
                radarrId: movie.id,
                sizeMB,
                hoursSinceAdded: hoursSinceAdded.toFixed(1),
                action: 'delete_files_and_entry',
              });

              await radarr['axios'].delete(`/movie/${movie.id}`, {
                params: {
                  deleteFiles: true,
                  addImportExclusion: false,
                },
              });

              logger.info('Successfully removed movie from Radarr', {
                label: 'Blocklist Enforce',
                serverName: server.name,
                title: movie.title,
                tmdbId: movie.tmdbId,
                radarrId: movie.id,
                sizeMB,
                bytesFreed: movieSize,
                metric_enforcement_items_removed: 1,
                metric_enforcement_bytes_freed: movieSize,
              });
            } catch (error) {
              logger.error('Failed to remove movie from Radarr', {
                label: 'Blocklist Enforce',
                serverName: server.name,
                title: movie.title,
                tmdbId: movie.tmdbId,
                radarrId: movie.id,
                error: error.message,
                metric_enforcement_errors: 1,
              });
              
              stats.totalErrors++;
              continue;
            }

            removedCount++;
            stats.totalRemoved++;
          }
        }

        logger.info('Completed enforcement for Radarr server', {
          label: 'Blocklist Enforce',
          serverName: server.name,
          removedCount,
        });
      } catch (error) {
        logger.error('Error enforcing blocklist on Radarr', {
          label: 'Blocklist Enforce',
          serverName: server.name,
          error: error.message,
        });
        stats.totalErrors++;
      }
    }

    logger.info('Blocklist enforcement completed', {
      label: 'Blocklist Enforce',
      stats,
    });

    return stats;
  }

  public async syncSeerrToRadarr(): Promise<SyncStats> {
    logger.info('Syncing Seerr blocklist TO Radarr exclusions', {
      label: 'Blocklist Export',
    });

    const settings = getSettings();
    const stats: SyncStats = {
      totalServers: 0,
      totalItems: 0,
      totalAdded: 0,
      totalUpdated: 0,
      totalRemoved: 0,
      totalErrors: 0,
    };

    const radarrServers = uniqWith(
      settings.radarr.filter((server) => server.syncEnabled !== false),
      (a, b) =>
        a.hostname === b.hostname &&
        a.port === b.port &&
        a.baseUrl === b.baseUrl
    );

    if (radarrServers.length === 0) {
      return stats;
    }

    const blocklistRepository = getRepository(Blocklist);
    const movieBlocklist = await blocklistRepository.find({
      where: { mediaType: MediaType.MOVIE },
    });

    for (const server of radarrServers) {
      try {
        const radarr = new RadarrAPI({
          apiKey: server.apiKey,
          url: RadarrAPI.buildUrl(server, '/api/v3'),
        });

        const existingExclusions = await radarr.getImportExclusions();
        const exclusionMap = new Map(existingExclusions.map((e) => [e.tmdbId, e]));

        let addedCount = 0;
        for (const entry of movieBlocklist) {
          if (!exclusionMap.has(entry.tmdbId)) {
            try {
              const tmdb = new TheMovieDb();
              const movie = await tmdb.getMovie({ movieId: entry.tmdbId });
              await radarr.addImportExclusion({
                tmdbId: entry.tmdbId,
                movieTitle: entry.title || movie.title,
                movieYear: movie.release_date ? parseInt(movie.release_date.substring(0, 4)) : new Date().getFullYear(),
              });
              addedCount++;
              stats.totalAdded++;
            } catch (error) {
              stats.totalErrors++;
            }
          }
        }
        logger.info('Seerr → Radarr sync complete', {
          label: 'Blocklist Export',
          serverName: server.name,
          addedCount,
        });
      } catch (error) {
        stats.totalErrors++;
      }
    }
    return stats;
  }

  public async syncSeerrToSonarr(): Promise<SyncStats> {
    logger.info('Syncing Seerr blocklist TO Sonarr exclusions', {
      label: 'Blocklist Export',
    });

    const settings = getSettings();
    const stats: SyncStats = {
      totalServers: 0,
      totalItems: 0,
      totalAdded: 0,
      totalUpdated: 0,
      totalRemoved: 0,
      totalErrors: 0,
    };

    const sonarrServers = uniqWith(
      settings.sonarr.filter((server) => server.syncEnabled !== false),
      (a, b) =>
        a.hostname === b.hostname &&
        a.port === b.port &&
        a.baseUrl === b.baseUrl
    );

    if (sonarrServers.length === 0) {
      return stats;
    }

    const blocklistRepository = getRepository(Blocklist);
    const tvBlocklist = await blocklistRepository.find({
      where: { mediaType: MediaType.TV },
    });

    for (const server of sonarrServers) {
      try {
        const sonarr = new SonarrAPI({
          apiKey: server.apiKey,
          url: SonarrAPI.buildUrl(server, '/api/v3'),
        });

        const existingExclusions = await sonarr.getImportExclusions();
        const exclusionByTvdb = new Map(
          existingExclusions.map((e) => [e.tvdbId, e])
        );

        let addedCount = 0;
        for (const entry of tvBlocklist) {
          try {
            // Resolve TMDB → TVDB to check if already excluded
            const tmdb = new TheMovieDb();
            const tvShow = await tmdb.getTvShow({ tvId: entry.tmdbId });
            const tvdbId = tvShow.external_ids?.tvdb_id;

            if (!tvdbId) {
              continue;
            }

            if (!exclusionByTvdb.has(tvdbId)) {
              await sonarr.addImportExclusion({
                tvdbId,
                title: entry.title || tvShow.name,
              });
              addedCount++;
              stats.totalAdded++;
            }
          } catch (error) {
            stats.totalErrors++;
          }
        }

        logger.info('Seerr → Sonarr sync complete', {
          label: 'Blocklist Export',
          serverName: server.name,
          addedCount,
        });
      } catch (error) {
        stats.totalErrors++;
      }
    }
    return stats;
  }

  public async syncSonarrExclusionRemovals(): Promise<SyncStats> {
    logger.info('Syncing blocklist removals to Sonarr', {
      label: 'Blocklist Sync Removals',
    });

    const settings = getSettings();
    const stats: SyncStats = {
      totalServers: 0,
      totalItems: 0,
      totalAdded: 0,
      totalUpdated: 0,
      totalRemoved: 0,
      totalErrors: 0,
    };

    const sonarrServers = uniqWith(
      settings.sonarr.filter((server) => server.syncEnabled !== false),
      (a, b) =>
        a.hostname === b.hostname &&
        a.port === b.port &&
        a.baseUrl === b.baseUrl
    );

    if (sonarrServers.length === 0) {
      return stats;
    }

    stats.totalServers = sonarrServers.length;

    const blocklistRepository = getRepository(Blocklist);
    const blocklistedTv = await blocklistRepository.find({
      where: { mediaType: MediaType.TV },
      select: ['tmdbId', 'blocklistedTags'],
    });

    // Build a TMDB ID set for quick lookup
    const blocklistTmdbIds = new Set(blocklistedTv.map((item) => item.tmdbId));

    for (const server of sonarrServers) {
      try {
        const sonarr = new SonarrAPI({
          apiKey: server.apiKey,
          url: SonarrAPI.buildUrl(server, '/api/v3'),
        });

        const exclusions = await sonarr.getImportExclusions();
        let removedCount = 0;

        for (const exclusion of exclusions) {
          try {
            // Resolve TVDB → TMDB to check against blocklist
            const tmdb = new TheMovieDb();
            const extResponse = await tmdb.getByExternalId({
              externalId: exclusion.tvdbId,
              type: 'tvdb',
            });

            const tmdbId = extResponse.tv_results?.[0]?.id;

            if (tmdbId && !blocklistTmdbIds.has(tmdbId)) {
              logger.info('Removing exclusion from Sonarr (no longer blocklisted in Seerr)', {
                label: 'Blocklist Sync Removals',
                serverName: server.name,
                title: exclusion.title,
                tvdbId: exclusion.tvdbId,
                tmdbId,
                exclusionId: exclusion.id,
              });

              await sonarr.deleteImportExclusion(exclusion.id);
              removedCount++;
              stats.totalRemoved++;
            }
          } catch {
            // Skip unresolvable exclusions — don't remove what we can't verify
          }
        }

        logger.info('Completed exclusion removal sync for Sonarr server', {
          label: 'Blocklist Sync Removals',
          serverName: server.name,
          removedCount,
        });
      } catch (error) {
        logger.error('Error syncing exclusion removals from Sonarr', {
          label: 'Blocklist Sync Removals',
          serverName: server.name,
          error: error.message,
        });
        stats.totalErrors++;
      }
    }

    return stats;
  }

  public async syncRadarrExclusionRemovals(): Promise<SyncStats> {
    logger.info('Syncing blocklist removals to Radarr', {
      label: 'Blocklist Sync Removals',
    });

    const settings = getSettings();
    const stats: SyncStats = {
      totalServers: 0,
      totalItems: 0,
      totalAdded: 0,
      totalUpdated: 0,
      totalRemoved: 0,
      totalErrors: 0,
    };

    const radarrServers = uniqWith(
      settings.radarr.filter((server) => server.syncEnabled !== false),
      (a, b) =>
        a.hostname === b.hostname &&
        a.port === b.port &&
        a.baseUrl === b.baseUrl
    );

    if (radarrServers.length === 0) {
      logger.debug('No Radarr servers configured for exclusion removal sync', {
        label: 'Blocklist Sync Removals',
      });
      return stats;
    }

    stats.totalServers = radarrServers.length;

    const blocklistRepository = getRepository(Blocklist);
    const blocklistedMovies = await blocklistRepository.find({
      where: { mediaType: MediaType.MOVIE },
      select: ['tmdbId', 'blocklistedTags'],
    });

    const blocklistTmdbIds = new Set(
      blocklistedMovies.map((item) => item.tmdbId)
    );

    logger.info('Checking Radarr exclusions against Seerr blocklist', {
      label: 'Blocklist Sync Removals',
      blocklistedCount: blocklistedMovies.length,
      serverCount: radarrServers.length,
    });

    for (const server of radarrServers) {
      try {
        const radarr = new RadarrAPI({
          apiKey: server.apiKey,
          url: RadarrAPI.buildUrl(server, '/api/v3'),
        });

        const exclusions = await radarr.getImportExclusions();
        let removedCount = 0;

        for (const exclusion of exclusions) {
          if (!blocklistTmdbIds.has(exclusion.tmdbId)) {
            logger.info('Removing exclusion from Radarr (no longer blocklisted in Seerr)', {
              label: 'Blocklist Sync Removals',
              serverName: server.name,
              title: exclusion.movieTitle,
              tmdbId: exclusion.tmdbId,
              exclusionId: exclusion.id,
            });

            await radarr.deleteImportExclusion(exclusion.id);
            removedCount++;
            stats.totalRemoved++;
          }
        }

        logger.info('Completed exclusion removal sync for Radarr server', {
          label: 'Blocklist Sync Removals',
          serverName: server.name,
          removedCount,
        });
      } catch (error) {
        logger.error('Error syncing exclusion removals from Radarr', {
          label: 'Blocklist Sync Removals',
          serverName: server.name,
          error: error.message,
        });
        stats.totalErrors++;
      }
    }

    logger.info('Exclusion removal sync completed', {
      label: 'Blocklist Sync Removals',
      stats,
    });

    return stats;
  }
}

const blocklistSyncService = new BlocklistSyncService();
export default blocklistSyncService;
