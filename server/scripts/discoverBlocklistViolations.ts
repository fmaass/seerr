#!/usr/bin/env node
/**
 * Blocklist Enforcement Discovery Script
 *
 * This script discovers items in Radarr/Sonarr that are blocklisted in Seerr.
 * It performs NO modifications - only reads and reports.
 *
 * Purpose: Identify scope of enforcement needed before implementing 2-way sync.
 */

import RadarrAPI from '@server/api/servarr/radarr';
import SonarrAPI from '@server/api/servarr/sonarr';
import { MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import { Blocklist } from '@server/entity/Blocklist';
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
  blocklistSource?: string;
}

interface ServerViolations {
  serverName: string;
  serverId: number;
  serverType: 'radarr' | 'sonarr';
  items: ViolationItem[];
  totalSize: number;
}

class BlocklistDiscovery {
  public async discoverRadarrViolations(): Promise<ServerViolations[]> {
    const settings = getSettings();
    const violations: ServerViolations[] = [];

    const radarrServers = uniqWith(
      settings.radarr.filter((server) => server.syncEnabled !== false),
      (a, b) =>
        a.hostname === b.hostname &&
        a.port === b.port &&
        a.baseUrl === b.baseUrl
    );

    logger.info('Discovering Radarr violations', {
      label: 'Blocklist Discovery',
      serverCount: radarrServers.length,
    });

    const blocklistRepository = getRepository(Blocklist);
    const blocklistedMovies = await blocklistRepository.find({
      where: {
        mediaType: MediaType.MOVIE,
      },
      select: ['tmdbId', 'title', 'blocklistedTags'],
    });

    logger.info('Found blocklisted movies in Seerr', {
      label: 'Blocklist Discovery',
      count: blocklistedMovies.length,
    });

    if (blocklistedMovies.length === 0) {
      logger.info('No blocklisted movies found in Seerr', {
        label: 'Blocklist Discovery',
      });
      return violations;
    }

    const blocklistMap = new Map(
      blocklistedMovies.map((item) => [
        item.tmdbId,
        {
          title: item.title,
          source: item.blocklistedTags,
        },
      ])
    );

    for (const server of radarrServers) {
      try {
        logger.info('Checking Radarr server', {
          label: 'Blocklist Discovery',
          serverName: server.name,
          serverId: server.id,
        });

        const radarr = new RadarrAPI({
          apiKey: server.apiKey,
          url: RadarrAPI.buildUrl(server, '/api/v3'),
        });

        const radarrMovies = await radarr.getMovies();
        logger.info('Retrieved movies from Radarr', {
          label: 'Blocklist Discovery',
          serverName: server.name,
          count: radarrMovies.length,
        });

        const serverViolations: ViolationItem[] = [];
        let totalSize = 0;

        for (const movie of radarrMovies) {
          if (movie.tmdbId && blocklistMap.has(movie.tmdbId)) {
            const blocklistInfo = blocklistMap.get(movie.tmdbId);
            const movieSize = movie.movieFile?.size || 0;
            const item: ViolationItem = {
              title: movie.title,
              tmdbId: movie.tmdbId,
              arrId: movie.id,
              year: undefined,
              sizeOnDisk: movieSize,
              added: movie.added ? new Date(movie.added) : undefined,
              monitored: movie.monitored,
              blocklistSource: blocklistInfo?.source,
            };

            serverViolations.push(item);
            totalSize += movieSize;

            logger.debug('Found violation', {
              label: 'Blocklist Discovery',
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
          label: 'Blocklist Discovery',
          serverName: server.name,
          violations: serverViolations.length,
          totalSizeGB: (totalSize / 1024 / 1024 / 1024).toFixed(2),
        });
      } catch (error) {
        logger.error('Error checking Radarr server', {
          label: 'Blocklist Discovery',
          serverName: server.name,
          error: error.message,
        });
      }
    }

    return violations;
  }

  public async discoverSonarrViolations(): Promise<ServerViolations[]> {
    const settings = getSettings();
    const violations: ServerViolations[] = [];

    const sonarrServers = uniqWith(
      settings.sonarr.filter((server) => server.syncEnabled !== false),
      (a, b) =>
        a.hostname === b.hostname &&
        a.port === b.port &&
        a.baseUrl === b.baseUrl
    );

    logger.info('Discovering Sonarr violations', {
      label: 'Blocklist Discovery',
      serverCount: sonarrServers.length,
    });

    const blocklistRepository = getRepository(Blocklist);
    const blocklistedShows = await blocklistRepository.find({
      where: {
        mediaType: MediaType.TV,
      },
      select: ['tmdbId', 'title', 'blocklistedTags'],
    });

    logger.info('Found blocklisted TV shows in Seerr', {
      label: 'Blocklist Discovery',
      count: blocklistedShows.length,
    });

    if (blocklistedShows.length === 0) {
      logger.info('No blocklisted TV shows found in Seerr', {
        label: 'Blocklist Discovery',
      });
      return violations;
    }

    for (const server of sonarrServers) {
      try {
        logger.info('Checking Sonarr server', {
          label: 'Blocklist Discovery',
          serverName: server.name,
          serverId: server.id,
        });

        const sonarr = new SonarrAPI({
          apiKey: server.apiKey,
          url: SonarrAPI.buildUrl(server, '/api/v3'),
        });

        const sonarrSeries = await sonarr.getSeries();
        logger.info('Retrieved series from Sonarr', {
          label: 'Blocklist Discovery',
          serverName: server.name,
          count: sonarrSeries.length,
        });

        const serverViolations: ViolationItem[] = [];
        const totalSize = 0;

        violations.push({
          serverName: server.name,
          serverId: server.id,
          serverType: 'sonarr',
          items: serverViolations,
          totalSize,
        });

        logger.info('Completed Sonarr server scan', {
          label: 'Blocklist Discovery',
          serverName: server.name,
          violations: serverViolations.length,
          note: 'TVDB->TMDB mapping needed for full implementation',
        });
      } catch (error) {
        logger.error('Error checking Sonarr server', {
          label: 'Blocklist Discovery',
          serverName: server.name,
          error: error.message,
        });
      }
    }

    return violations;
  }

  public generateReport(
    radarrViolations: ServerViolations[],
    sonarrViolations: ServerViolations[]
  ): string {
    const lines: string[] = [];
    const separator = '='.repeat(60);

    lines.push('');
    lines.push(separator);
    lines.push('BLOCKLIST ENFORCEMENT DISCOVERY REPORT');
    lines.push(separator);
    lines.push('');

    let totalItems = 0;
    let totalSize = 0;

    if (radarrViolations.length > 0) {
      lines.push('RADARR SERVERS');
      lines.push(separator);
      lines.push('');

      for (const serverViolation of radarrViolations) {
        lines.push(
          `Server: ${serverViolation.serverName} (ID: ${serverViolation.serverId})`
        );
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
            const source = item.blocklistSource || 'manual';

            lines.push(`  - ${item.title} (${item.year || 'N/A'})`);
            lines.push(`    TMDB: ${item.tmdbId} | Radarr ID: ${item.arrId}`);
            lines.push(
              `    Size: ${sizeGB} GB | Added: ${added} | Monitored: ${item.monitored}`
            );
            lines.push(`    Blocklist source: ${source}`);
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

    if (sonarrViolations.length > 0) {
      lines.push('SONARR SERVERS');
      lines.push(separator);
      lines.push('');

      for (const serverViolation of sonarrViolations) {
        lines.push(
          `Server: ${serverViolation.serverName} (ID: ${serverViolation.serverId})`
        );
        lines.push(`Items found: ${serverViolation.items.length}`);
        lines.push(
          'Note: TVDB->TMDB mapping needed for full Sonarr support'
        );
        lines.push('');
        lines.push(separator);
        lines.push('');
      }
    }

    lines.push('SUMMARY');
    lines.push(separator);
    lines.push('');
    lines.push(`Total items that would be removed: ${totalItems}`);
    lines.push(
      `Total disk space to be freed: ${(totalSize / 1024 / 1024 / 1024).toFixed(2)} GB`
    );
    lines.push('');
    lines.push('NOTE: This is a discovery report only.');
    lines.push('   No items have been deleted or modified.');
    lines.push('');
    lines.push(separator);
    lines.push('');

    return lines.join('\n');
  }
}

async function main() {
  logger.info('Starting blocklist violation discovery', {
    label: 'Blocklist Discovery',
  });

  try {
    const dataSource = (await import('@server/datasource')).default;

    if (!dataSource.isInitialized) {
      logger.info('Initializing database connection', {
        label: 'Blocklist Discovery',
      });
      await dataSource.initialize();
    }

    const discovery = new BlocklistDiscovery();

    const radarrViolations = await discovery.discoverRadarrViolations();
    const sonarrViolations = await discovery.discoverSonarrViolations();

    const report = discovery.generateReport(radarrViolations, sonarrViolations);
    console.log(report);

    logger.info('Discovery completed successfully', {
      label: 'Blocklist Discovery',
    });

    await dataSource.destroy();
    process.exit(0);
  } catch (error) {
    logger.error('Discovery failed', {
      label: 'Blocklist Discovery',
      error: error.message,
      stack: error.stack,
    });
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

export default BlocklistDiscovery;
