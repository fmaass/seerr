#!/usr/bin/env node
/**
 * Blacklist Enforcement Discovery Script
 * 
 * This script discovers items in Radarr/Sonarr that are blacklisted in Seerr.
 * It performs NO modifications - only reads and reports.
 * 
 * Purpose: Identify scope of enforcement needed before implementing 2-way sync.
 */

import RadarrAPI from '@server/api/servarr/radarr';
import SonarrAPI from '@server/api/servarr/sonarr';
import { MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import { Blacklist } from '@server/entity/Blacklist';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { uniqWith } from 'lodash';

interface ViolationItem {
  title: string;
  tmdbId: number;
  arrId: number;
  year?: number;
  sizeOnDisk?: number;
  added?: Date;
  monitored: boolean;
  blacklistSource?: string;
}

interface ServerViolations {
  serverName: string;
  serverId: number;
  serverType: 'radarr' | 'sonarr';
  items: ViolationItem[];
  totalSize: number;
}

class BlacklistDiscovery {
  /**
   * Discover all Radarr items that violate Seerr blacklist
   */
  public async discoverRadarrViolations(): Promise<ServerViolations[]> {
    const settings = getSettings();
    const violations: ServerViolations[] = [];

    // Get unique Radarr servers
    const radarrServers = uniqWith(
      settings.radarr.filter((server) => server.syncEnabled !== false),
      (a, b) =>
        a.hostname === b.hostname &&
        a.port === b.port &&
        a.baseUrl === b.baseUrl
    );

    logger.info('Discovering Radarr violations', {
      label: 'Blacklist Discovery',
      serverCount: radarrServers.length,
    });

    // Get all blacklisted movies from Seerr
    const blacklistRepository = getRepository(Blacklist);
    const blacklistedMovies = await blacklistRepository.find({
      where: {
        mediaType: MediaType.MOVIE,
      },
      select: ['tmdbId', 'title', 'blacklistedTags'],
    });

    logger.info('Found blacklisted movies in Seerr', {
      label: 'Blacklist Discovery',
      count: blacklistedMovies.length,
    });

    if (blacklistedMovies.length === 0) {
      logger.info('No blacklisted movies found in Seerr', {
        label: 'Blacklist Discovery',
      });
      return violations;
    }

    // Create lookup map for faster searching
    const blacklistMap = new Map(
      blacklistedMovies.map((item) => [
        item.tmdbId,
        {
          title: item.title,
          source: item.blacklistedTags,
        },
      ])
    );

    // Check each Radarr server
    for (const server of radarrServers) {
      try {
        logger.info('Checking Radarr server', {
          label: 'Blacklist Discovery',
          serverName: server.name,
          serverId: server.id,
        });

        const radarr = new RadarrAPI({
          apiKey: server.apiKey,
          url: RadarrAPI.buildUrl(server, '/api/v3'),
        });

        // Get all movies from Radarr
        const radarrMovies = await radarr.getMovies();
        logger.info('Retrieved movies from Radarr', {
          label: 'Blacklist Discovery',
          serverName: server.name,
          count: radarrMovies.length,
        });

        // Find violations
        const serverViolations: ViolationItem[] = [];
        let totalSize = 0;

        for (const movie of radarrMovies) {
          if (movie.tmdbId && blacklistMap.has(movie.tmdbId)) {
            const blacklistInfo = blacklistMap.get(movie.tmdbId);
            const movieSize = movie.movieFile?.size || 0;
            const item: ViolationItem = {
              title: movie.title,
              tmdbId: movie.tmdbId,
              arrId: movie.id,
              year: undefined, // Year not directly available in RadarrMovie
              sizeOnDisk: movieSize,
              added: movie.added ? new Date(movie.added) : undefined,
              monitored: movie.monitored,
              blacklistSource: blacklistInfo?.source,
            };

            serverViolations.push(item);
            totalSize += movieSize;

            logger.debug('Found violation', {
              label: 'Blacklist Discovery',
              title: movie.title,
              tmdbId: movie.tmdbId,
              radarrId: movie.id,
            });
          }
        }

        violations.push({
          serverName: server.name,
          serverId: server.id,
          serverType: 'radarr',
          items: serverViolations,
          totalSize,
        });

        logger.info('Completed Radarr server scan', {
          label: 'Blacklist Discovery',
          serverName: server.name,
          violations: serverViolations.length,
          totalSizeGB: (totalSize / 1024 / 1024 / 1024).toFixed(2),
        });
      } catch (error) {
        logger.error('Error checking Radarr server', {
          label: 'Blacklist Discovery',
          serverName: server.name,
          error: error.message,
        });
      }
    }

    return violations;
  }

  /**
   * Discover all Sonarr items that violate Seerr blacklist
   */
  public async discoverSonarrViolations(): Promise<ServerViolations[]> {
    const settings = getSettings();
    const violations: ServerViolations[] = [];

    // Get unique Sonarr servers
    const sonarrServers = uniqWith(
      settings.sonarr.filter((server) => server.syncEnabled !== false),
      (a, b) =>
        a.hostname === b.hostname &&
        a.port === b.port &&
        a.baseUrl === b.baseUrl
    );

    logger.info('Discovering Sonarr violations', {
      label: 'Blacklist Discovery',
      serverCount: sonarrServers.length,
    });

    // Get all blacklisted TV shows from Seerr
    const blacklistRepository = getRepository(Blacklist);
    const blacklistedShows = await blacklistRepository.find({
      where: {
        mediaType: MediaType.TV,
      },
      select: ['tmdbId', 'title', 'blacklistedTags'],
    });

    logger.info('Found blacklisted TV shows in Seerr', {
      label: 'Blacklist Discovery',
      count: blacklistedShows.length,
    });

    if (blacklistedShows.length === 0) {
      logger.info('No blacklisted TV shows found in Seerr', {
        label: 'Blacklist Discovery',
      });
      return violations;
    }

    // Create lookup map
    const blacklistMap = new Map(
      blacklistedShows.map((item) => [
        item.tmdbId,
        {
          title: item.title,
          source: item.blacklistedTags,
        },
      ])
    );

    // Check each Sonarr server
    for (const server of sonarrServers) {
      try {
        logger.info('Checking Sonarr server', {
          label: 'Blacklist Discovery',
          serverName: server.name,
          serverId: server.id,
        });

        const sonarr = new SonarrAPI({
          apiKey: server.apiKey,
          url: SonarrAPI.buildUrl(server, '/api/v3'),
        });

        // Get all series from Sonarr
        const sonarrSeries = await sonarr.getSeries();
        logger.info('Retrieved series from Sonarr', {
          label: 'Blacklist Discovery',
          serverName: server.name,
          count: sonarrSeries.length,
        });

        // Find violations (need to map TVDB to TMDB - this is complex)
        // For now, we'll skip TVDB->TMDB mapping and just check if we can match
        const serverViolations: ViolationItem[] = [];
        let totalSize = 0;

        for (const series of sonarrSeries) {
          // Note: Sonarr uses TVDB ID, not TMDB directly
          // We'll need to handle this in the actual implementation
          // For now, just log that we found series
        }

        violations.push({
          serverName: server.name,
          serverId: server.id,
          serverType: 'sonarr',
          items: serverViolations,
          totalSize,
        });

        logger.info('Completed Sonarr server scan', {
          label: 'Blacklist Discovery',
          serverName: server.name,
          violations: serverViolations.length,
          note: 'TVDB->TMDB mapping needed for full implementation',
        });
      } catch (error) {
        logger.error('Error checking Sonarr server', {
          label: 'Blacklist Discovery',
          serverName: server.name,
          error: error.message,
        });
      }
    }

    return violations;
  }

  /**
   * Generate human-readable report
   */
  public generateReport(
    radarrViolations: ServerViolations[],
    sonarrViolations: ServerViolations[]
  ): string {
    const lines: string[] = [];
    const separator = '='.repeat(60);

    lines.push('');
    lines.push(separator);
    lines.push('BLACKLIST ENFORCEMENT DISCOVERY REPORT');
    lines.push(separator);
    lines.push('');

    let totalItems = 0;
    let totalSize = 0;

    // Radarr violations
    if (radarrViolations.length > 0) {
      lines.push('RADARR SERVERS');
      lines.push(separator);
      lines.push('');

      for (const serverViolation of radarrViolations) {
        lines.push(`Server: ${serverViolation.serverName} (ID: ${serverViolation.serverId})`);
        lines.push(`Items found: ${serverViolation.items.length}`);
        lines.push('');

        if (serverViolation.items.length > 0) {
          lines.push('Movies that would be removed:');
          lines.push('');

          for (const item of serverViolation.items) {
            const sizeGB = item.sizeOnDisk
              ? (item.sizeOnDisk / 1024 / 1024 / 1024).toFixed(2)
              : '0.00';
            const added = item.added
              ? item.added.toISOString().split('T')[0]
              : 'Unknown';
            const source = item.blacklistSource || 'manual';

            lines.push(
              `  • ${item.title} (${item.year || 'N/A'})`
            );
            lines.push(
              `    TMDB: ${item.tmdbId} | Radarr ID: ${item.arrId}`
            );
            lines.push(
              `    Size: ${sizeGB} GB | Added: ${added} | Monitored: ${item.monitored}`
            );
            lines.push(
              `    Blacklist source: ${source}`
            );
            lines.push('');
          }

          const serverSizeGB = (
            serverViolation.totalSize /
            1024 /
            1024 /
            1024
          ).toFixed(2);
          lines.push(
            `  Server total: ${serverViolation.items.length} items (${serverSizeGB} GB)`
          );
          lines.push('');

          totalItems += serverViolation.items.length;
          totalSize += serverViolation.totalSize;
        }

        lines.push(separator);
        lines.push('');
      }
    }

    // Sonarr violations
    if (sonarrViolations.length > 0) {
      lines.push('SONARR SERVERS');
      lines.push(separator);
      lines.push('');

      for (const serverViolation of sonarrViolations) {
        lines.push(`Server: ${serverViolation.serverName} (ID: ${serverViolation.serverId})`);
        lines.push(`Items found: ${serverViolation.items.length}`);
        lines.push('Note: TVDB->TMDB mapping needed for full Sonarr support');
        lines.push('');
        lines.push(separator);
        lines.push('');
      }
    }

    // Summary
    lines.push('SUMMARY');
    lines.push(separator);
    lines.push('');
    lines.push(`Total items that would be removed: ${totalItems}`);
    lines.push(
      `Total disk space to be freed: ${(totalSize / 1024 / 1024 / 1024).toFixed(2)} GB`
    );
    lines.push('');
    lines.push('⚠️  NOTE: This is a discovery report only.');
    lines.push('   No items have been deleted or modified.');
    lines.push('');
    lines.push(separator);
    lines.push('');

    return lines.join('\n');
  }
}

// Main execution
async function main() {
  const discovery = new BlacklistDiscovery();

  logger.info('Starting blacklist violation discovery', {
    label: 'Blacklist Discovery',
  });

  try {
    // Discover violations
    const radarrViolations = await discovery.discoverRadarrViolations();
    const sonarrViolations = await discovery.discoverSonarrViolations();

    // Generate and display report
    const report = discovery.generateReport(radarrViolations, sonarrViolations);
    console.log(report);

    logger.info('Discovery completed successfully', {
      label: 'Blacklist Discovery',
    });

    process.exit(0);
  } catch (error) {
    logger.error('Discovery failed', {
      label: 'Blacklist Discovery',
      error: error.message,
    });
    process.exit(1);
  }
}

// Run if executed directly
if (require.main === module) {
  main();
}

export default BlacklistDiscovery;

