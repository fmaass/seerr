import RadarrAPI from '@server/api/servarr/radarr';
import type { RadarrImportExclusion } from '@server/api/servarr/radarr';
import SonarrAPI from '@server/api/servarr/sonarr';
import type { SonarrImportExclusion } from '@server/api/servarr/sonarr';
import TheMovieDb from '@server/api/themoviedb';
import { MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import { Blacklist } from '@server/entity/Blacklist';
import {
  getSettings,
  type RadarrSettings,
  type SonarrSettings,
} from '@server/lib/settings';
import logger from '@server/logger';
import { uniqWith } from 'lodash';
import { register, Gauge, Counter } from 'prom-client';

// Prometheus Metrics for Blocklist Enforcement
const blocklistEnforcementGauge = new Gauge({
  name: 'seerr_blocklist_enforcement_items_removed_total',
  help: 'Total number of items removed by blocklist enforcement',
  labelNames: ['server_type', 'server_name'],
  registers: [register],
});

const blocklistEnforcementBytes = new Gauge({
  name: 'seerr_blocklist_enforcement_bytes_freed',
  help: 'Total bytes freed by blocklist enforcement',
  labelNames: ['server_type', 'server_name'],
  registers: [register],
});

const blocklistEnforcementErrors = new Counter({
  name: 'seerr_blocklist_enforcement_errors_total',
  help: 'Total errors during blocklist enforcement',
  labelNames: ['server_type', 'server_name', 'error_type'],
  registers: [register],
});

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
   * Sync blocklist from all configured Radarr servers to Seerr blacklist
   * @returns Sync statistics
   */
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

    // Get unique Radarr servers (filter duplicates and check blocklist sync enabled)
    // blocklistSyncEnabled defaults to true if undefined
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

    // Sync each Radarr server
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

  /**
   * Sync blocklist from a single Radarr server to Seerr blacklist
   * @param server Radarr server configuration
   * @returns Sync result for this server
   */
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

      // Fetch all import exclusions from Radarr
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

      const blacklistRepository = getRepository(Blacklist);

      if (exclusions.length === 0) {
        // Even if no exclusions, we should still check for items to remove
        // that were previously synced from this server
        const syncedItems = await blacklistRepository
          .createQueryBuilder('blacklist')
          .where('blacklist.mediaType = :mediaType', {
            mediaType: MediaType.MOVIE,
          })
          .andWhere('blacklist.blacklistedTags LIKE :tagPattern', {
            tagPattern: `radarr-sync-${server.id}-%`,
          })
          .getMany();

        for (const item of syncedItems) {
          try {
            await blacklistRepository.remove(item);
            result.removed++;
            logger.debug('Removed movie from blacklist (no longer in Radarr)', {
              label: 'Blocklist Sync',
              serverName: server.name,
              serverId: server.id,
              tmdbId: item.tmdbId,
              title: item.title,
            });
          } catch (e) {
            logger.warn('Failed to remove movie from blacklist', {
              label: 'Blocklist Sync',
              serverName: server.name,
              serverId: server.id,
              tmdbId: item.tmdbId,
              errorMessage: e.message,
            });
            result.errors++;
          }
        }

        logger.debug('No exclusions found in Radarr server', {
          label: 'Blocklist Sync',
          serverName: server.name,
          serverId: server.id,
        });
        return result;
      }

      // Track which TMDB IDs are still in Radarr blocklist
      const currentTmdbIds = new Set(
        exclusions.map((exclusion) => exclusion.tmdbId)
      );

      // Process each exclusion (add/update)
      for (const exclusion of exclusions) {
        try {
          const wasNew = await this.syncMovie(
            exclusion,
            blacklistRepository,
            server.id
          );
          if (wasNew) {
            result.added++;
          } else {
            result.updated++;
          }
        } catch (e) {
          logger.warn('Failed to sync movie to blacklist', {
            label: 'Blocklist Sync',
            serverName: server.name,
            serverId: server.id,
            tmdbId: exclusion.tmdbId,
            errorMessage: e.message,
          });
          result.errors++;
        }
      }

      // Remove items that are no longer in Radarr blocklist
      // Only remove items that were synced from this specific server
      const syncedItems = await blacklistRepository
        .createQueryBuilder('blacklist')
        .where('blacklist.mediaType = :mediaType', {
          mediaType: MediaType.MOVIE,
        })
        .andWhere('blacklist.blacklistedTags LIKE :tagPattern', {
          tagPattern: `radarr-sync-${server.id}-%`,
        })
        .getMany();

      for (const item of syncedItems) {
        // Check if this item is still in Radarr blocklist
        if (!currentTmdbIds.has(item.tmdbId)) {
          try {
            await blacklistRepository.remove(item);
            result.removed++;
            logger.debug('Removed movie from blacklist (no longer in Radarr)', {
              label: 'Blocklist Sync',
              serverName: server.name,
              serverId: server.id,
              tmdbId: item.tmdbId,
              title: item.title,
            });
          } catch (e) {
            logger.warn('Failed to remove movie from blacklist', {
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
   * Sync a single movie exclusion to Seerr blacklist
   * @param exclusion Radarr import exclusion
   * @param blacklistRepository Blacklist repository
   * @returns true if new entry was added, false if existing entry was updated
   */
  private async syncMovie(
    exclusion: RadarrImportExclusion,
    blacklistRepository: ReturnType<typeof getRepository<Blacklist>>,
    serverId: number
  ): Promise<boolean> {
    // Check if already exists
    const existing = await blacklistRepository.findOne({
      where: {
        tmdbId: exclusion.tmdbId,
        mediaType: MediaType.MOVIE,
      },
    });

    if (existing) {
      // Update title if changed
      if (existing.title !== exclusion.movieTitle) {
        existing.title = exclusion.movieTitle;
        await blacklistRepository.save(existing);
        logger.debug('Updated blacklist entry title', {
          label: 'Blocklist Sync',
          tmdbId: exclusion.tmdbId,
          oldTitle: existing.title,
          newTitle: exclusion.movieTitle,
        });
      }

      // Update tag if it's a synced item to ensure it's tagged with current server
      if (
        existing.blacklistedTags?.startsWith('radarr-sync-') &&
        !existing.blacklistedTags.startsWith(`radarr-sync-${serverId}-`)
      ) {
        existing.blacklistedTags = `radarr-sync-${serverId}-${exclusion.id}`;
        await blacklistRepository.save(existing);
      }

      return false; // Existing entry updated
    }

    // Add new entry
    await Blacklist.addToBlacklist({
      blacklistRequest: {
        mediaType: MediaType.MOVIE,
        tmdbId: exclusion.tmdbId,
        title: exclusion.movieTitle,
        blacklistedTags: `radarr-sync-${serverId}-${exclusion.id}`, // Tag to identify synced items and source server
      },
    });

    logger.debug('Added movie to blacklist from Radarr', {
      label: 'Blocklist Sync',
      tmdbId: exclusion.tmdbId,
      movieTitle: exclusion.movieTitle,
      movieYear: exclusion.movieYear,
    });

    return true; // New entry added
  }

  /**
   * Sync blocklist from all configured Sonarr servers to Seerr blacklist
   * @returns Sync statistics
   */
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

    // Get unique Sonarr servers (filter duplicates and check blocklist sync enabled)
    // blocklistSyncEnabled defaults to true if undefined
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

    // Sync each Sonarr server
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

  /**
   * Sync blocklist from a single Sonarr server to Seerr blacklist
   * @param server Sonarr server configuration
   * @returns Sync result for this server
   */
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

      // Fetch all import exclusions from Sonarr
      const exclusions = await sonarrAPI.getImportExclusions();
      result.total = exclusions.length;

      if (!Array.isArray(exclusions)) {
        logger.error('Sonarr returned unexpected exclusions format', {
          label: 'Blocklist Sync',
          serverName: server.name,
          serverId: server.id,
          exclusions,
        });
        result.errors = 1;
        return result;
      }

      const blacklistRepository = getRepository(Blacklist);
      const tmdb = new TheMovieDb();

      if (exclusions.length === 0) {
        // Even if no exclusions, we should still check for items to remove
        // that were previously synced from this server
        const syncedItems = await blacklistRepository
          .createQueryBuilder('blacklist')
          .where('blacklist.mediaType = :mediaType', {
            mediaType: MediaType.TV,
          })
          .andWhere('blacklist.blacklistedTags LIKE :tagPattern', {
            tagPattern: `sonarr-sync-${server.id}-%`,
          })
          .getMany();

        for (const item of syncedItems) {
          try {
            await blacklistRepository.remove(item);
            result.removed++;
            logger.debug('Removed series from blacklist (no longer in Sonarr)', {
              label: 'Blocklist Sync',
              serverName: server.name,
              serverId: server.id,
              tmdbId: item.tmdbId,
              title: item.title,
            });
          } catch (e) {
            logger.warn('Failed to remove series from blacklist', {
              label: 'Blocklist Sync',
              serverName: server.name,
              serverId: server.id,
              tmdbId: item.tmdbId,
              errorMessage: e.message,
            });
            result.errors++;
          }
        }

        logger.debug('No exclusions found in Sonarr server', {
          label: 'Blocklist Sync',
          serverName: server.name,
          serverId: server.id,
        });
        return result;
      }

      // Map TVDB IDs to TMDB IDs for items currently in Sonarr blocklist
      const currentTmdbIds = new Set<number>();
      for (const exclusion of exclusions) {
        try {
          const tvShow = await tmdb.getShowByTvdbId({
            tvdbId: exclusion.tvdbId,
          });
          currentTmdbIds.add(tvShow.id);
        } catch (e) {
          // Skip if we can't map TVDB to TMDB
          logger.debug('Could not map TVDB to TMDB for removal check', {
            label: 'Blocklist Sync',
            tvdbId: exclusion.tvdbId,
            errorMessage: e.message,
          });
        }
      }

      // Process each exclusion (add/update)
      for (const exclusion of exclusions) {
        try {
          const wasNew = await this.syncSeries(
            exclusion,
            blacklistRepository,
            tmdb,
            server.id
          );
          if (wasNew) {
            result.added++;
          } else {
            result.updated++;
          }
        } catch (e) {
          logger.warn('Failed to sync series to blacklist', {
            label: 'Blocklist Sync',
            serverName: server.name,
            serverId: server.id,
            tvdbId: exclusion.tvdbId,
            errorMessage: e.message,
          });
          result.errors++;
        }
      }

      // Remove items that are no longer in Sonarr blocklist
      // Only remove items that were synced from this specific server
      const syncedItems = await blacklistRepository
        .createQueryBuilder('blacklist')
        .where('blacklist.mediaType = :mediaType', {
          mediaType: MediaType.TV,
        })
        .andWhere('blacklist.blacklistedTags LIKE :tagPattern', {
          tagPattern: `sonarr-sync-${server.id}-%`,
        })
        .getMany();

      for (const item of syncedItems) {
        // Check if this TMDB ID is still in Sonarr blocklist
        if (!currentTmdbIds.has(item.tmdbId)) {
          try {
            await blacklistRepository.remove(item);
            result.removed++;
            logger.debug('Removed series from blacklist (no longer in Sonarr)', {
              label: 'Blocklist Sync',
              serverName: server.name,
              serverId: server.id,
              tmdbId: item.tmdbId,
              title: item.title,
            });
          } catch (e) {
            logger.warn('Failed to remove series from blacklist', {
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
   * Sync a single series exclusion to Seerr blacklist
   * @param exclusion Sonarr import exclusion
   * @param blacklistRepository Blacklist repository
   * @param tmdb TMDB API instance
   * @returns true if new entry was added, false if existing entry was updated
   */
  private async syncSeries(
    exclusion: SonarrImportExclusion,
    blacklistRepository: ReturnType<typeof getRepository<Blacklist>>,
    tmdb: TheMovieDb,
    serverId: number
  ): Promise<boolean> {
    // Map TVDB ID to TMDB ID
    let tmdbId: number | undefined;
    try {
      const tvShow = await tmdb.getShowByTvdbId({
        tvdbId: exclusion.tvdbId,
      });
      tmdbId = tvShow.id;
    } catch (e) {
      logger.warn('Failed to map TVDB ID to TMDB ID', {
        label: 'Blocklist Sync',
        tvdbId: exclusion.tvdbId,
        title: exclusion.title,
        errorMessage: e.message,
      });
      // Continue anyway - we'll use TVDB ID as fallback
    }

    if (!tmdbId) {
      logger.warn('Could not find TMDB ID for TVDB ID, skipping', {
        label: 'Blocklist Sync',
        tvdbId: exclusion.tvdbId,
        title: exclusion.title,
      });
      throw new Error(`TMDB ID not found for TVDB ID ${exclusion.tvdbId}`);
    }

    // Check if already exists
    const existing = await blacklistRepository.findOne({
      where: {
        tmdbId,
        mediaType: MediaType.TV,
      },
    });

    if (existing) {
      // Update title if changed
      if (existing.title !== exclusion.title) {
        existing.title = exclusion.title;
        await blacklistRepository.save(existing);
        logger.debug('Updated blacklist entry title', {
          label: 'Blocklist Sync',
          tmdbId,
          oldTitle: existing.title,
          newTitle: exclusion.title,
        });
      }

      // Update tag if it's a synced item to ensure it's tagged with current server
      if (
        existing.blacklistedTags?.startsWith('sonarr-sync-') &&
        !existing.blacklistedTags.startsWith(`sonarr-sync-${serverId}-`)
      ) {
        existing.blacklistedTags = `sonarr-sync-${serverId}-${exclusion.id}`;
        await blacklistRepository.save(existing);
      }

      return false; // Existing entry updated
    }

    // Add new entry
    await Blacklist.addToBlacklist({
      blacklistRequest: {
        mediaType: MediaType.TV,
        tmdbId,
        title: exclusion.title,
        blacklistedTags: `sonarr-sync-${serverId}-${exclusion.id}`, // Tag to identify synced items and source server
      },
    });

    logger.debug('Added series to blacklist from Sonarr', {
      label: 'Blocklist Sync',
      tmdbId,
      tvdbId: exclusion.tvdbId,
      seriesTitle: exclusion.title,
    });

    return true; // New entry added
  }
  /**
   * Enforce Seerr blacklist on Radarr (DRY RUN - logs only)
   * Finds movies in Radarr that are blacklisted in Seerr
   */
  public async enforceRadarrBlacklist(dryRun: boolean = true): Promise<SyncStats> {
    logger.info('enforceRadarrBlacklist called', {
      label: 'Blocklist Enforce',
      dryRun,
    });

    // Get settings (already loaded by main app)
    const settings = getSettings();
    const stats: SyncStats = {
      totalServers: 0,
      totalItems: 0,
      totalAdded: 0,
      totalUpdated: 0,
      totalRemoved: 0,
      totalErrors: 0,
    };

    logger.info('Checking for Radarr servers with enforcement', {
      label: 'Blocklist Enforce',
      totalRadarrServers: settings.radarr.length,
    });

    // Get servers with enforcement enabled
    const radarrServers = uniqWith(
      settings.radarr.filter(
        (server) => {
          logger.debug('Checking Radarr server', {
            label: 'Blocklist Enforce',
            serverName: server.name,
            syncEnabled: server.syncEnabled,
            blocklistEnforceEnabled: server.blocklistEnforceEnabled,
          });
          return (
            server.syncEnabled !== false &&
            server.blocklistEnforceEnabled === true
          );
        }
      ),
      (a, b) =>
        a.hostname === b.hostname &&
        a.port === b.port &&
        a.baseUrl === b.baseUrl
    );

    logger.info('Found Radarr servers with enforcement enabled', {
      label: 'Blocklist Enforce',
      count: radarrServers.length,
    });

    if (radarrServers.length === 0) {
      logger.warn('No Radarr servers with enforcement enabled', {
        label: 'Blocklist Enforce',
      });
      return stats;
    }

    stats.totalServers = radarrServers.length;

    // Get all blacklisted movies from Seerr
    const blacklistRepository = getRepository(Blacklist);
    const blacklistedMovies = await blacklistRepository.find({
      where: { mediaType: MediaType.MOVIE },
      select: ['tmdbId', 'title', 'blacklistedTags'],
    });

    logger.info('Enforcing blacklist on Radarr servers', {
      label: 'Blocklist Enforce',
      serverCount: radarrServers.length,
      blacklistedCount: blacklistedMovies.length,
      dryRun,
    });

    const blacklistMap = new Map(
      blacklistedMovies.map((item) => [item.tmdbId, item.title])
    );

    // Check each Radarr server
    for (const server of radarrServers) {
      try {
        const radarr = new RadarrAPI({
          apiKey: server.apiKey,
          url: RadarrAPI.buildUrl(server, '/api/v3'),
        });

        const radarrMovies = await radarr.getMovies();
        let removedCount = 0;

        for (const movie of radarrMovies) {
          if (movie.tmdbId && blacklistMap.has(movie.tmdbId)) {
            const movieSize = movie.movieFile?.size || 0;
            const sizeMB = (movieSize / 1024 / 1024).toFixed(2);
            
            // Safety: Skip recently added items (24-hour grace period)
            const addedDate = new Date(movie.added);
            const hoursSinceAdded = (Date.now() - addedDate.getTime()) / 1000 / 60 / 60;
            
            if (hoursSinceAdded < 24) {
              logger.debug('Skipping recently added movie (grace period)', {
                label: 'Blocklist Enforce',
                title: movie.title,
                tmdbId: movie.tmdbId,
                hoursSinceAdded: hoursSinceAdded.toFixed(1),
              });
              continue;
            }

            if (dryRun) {
              logger.info('[DRY RUN] Would remove movie from Radarr', {
                label: 'Blocklist Enforce',
                serverName: server.name,
                title: movie.title,
                tmdbId: movie.tmdbId,
                radarrId: movie.id,
                sizeMB,
                monitored: movie.monitored,
                hoursSinceAdded: hoursSinceAdded.toFixed(1),
              });
            } else {
              // Phase 4: Actual deletion
              try {
                logger.warn('Removing blacklisted movie from Radarr', {
                  label: 'Blocklist Enforce',
                  serverName: server.name,
                  title: movie.title,
                  tmdbId: movie.tmdbId,
                  radarrId: movie.id,
                  sizeMB,
                  action: 'delete_files_and_entry',
                });

                await radarr.axios.delete(`/movie/${movie.id}`, {
                  params: {
                    deleteFiles: true,
                    addImportExclusion: false, // Don't re-add to Radarr's exclusion list
                  },
                });

                logger.info('Successfully removed movie from Radarr', {
                  label: 'Blocklist Enforce',
                  serverName: server.name,
                  title: movie.title,
                  tmdbId: movie.tmdbId,
                  radarrId: movie.id,
                });

                // Update Prometheus metrics
                blocklistEnforcementGauge.inc({
                  server_type: 'radarr',
                  server_name: server.name,
                }, 1);
                blocklistEnforcementBytes.inc({
                  server_type: 'radarr',
                  server_name: server.name,
                }, movieSize);
              } catch (error) {
                logger.error('Failed to remove movie from Radarr', {
                  label: 'Blocklist Enforce',
                  serverName: server.name,
                  title: movie.title,
                  tmdbId: movie.tmdbId,
                  radarrId: movie.id,
                  error: error.message,
                });
                
                // Record error in metrics
                blocklistEnforcementErrors.inc({
                  server_type: 'radarr',
                  server_name: server.name,
                  error_type: error.code || 'unknown',
                });
                
                stats.totalErrors++;
                continue; // Continue with next movie even if one fails
              }
            }

            removedCount++;
            stats.totalRemoved++;
          }
        }

        logger.info('Completed enforcement for Radarr server', {
          label: 'Blocklist Enforce',
          serverName: server.name,
          removedCount,
          dryRun,
        });
      } catch (error) {
        logger.error('Error enforcing blacklist on Radarr', {
          label: 'Blocklist Enforce',
          serverName: server.name,
          error: error.message,
        });
        stats.totalErrors++;
      }
    }

    logger.info('Blacklist enforcement completed', {
      label: 'Blocklist Enforce',
      stats,
      dryRun,
    });

    return stats;
  }
}

const blocklistSyncService = new BlocklistSyncService();
export default blocklistSyncService;
