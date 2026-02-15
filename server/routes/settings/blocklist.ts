import { Router } from 'express';
import { getRepository } from '@server/datasource';
import { Blocklist } from '@server/entity/Blocklist';
import RadarrAPI from '@server/api/servarr/radarr';
import SonarrAPI from '@server/api/servarr/sonarr';
import { MediaType } from '@server/constants/media';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { uniqWith } from 'lodash';
import { isAuthenticated } from '@server/middleware/auth';
import { Permission } from '@server/lib/permissions';

const blocklistRoutes = Router();

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

blocklistRoutes.get(
  '/discover',
  isAuthenticated(Permission.ADMIN),
  async (req, res) => {
    try {
      logger.info('Starting blocklist discovery via API', {
        label: 'Blocklist API',
        userId: req.user?.id,
      });

      const settings = getSettings();
      const violations: {
        radarr: ServerViolations[];
        sonarr: ServerViolations[];
        summary: {
          totalItems: number;
          totalSize: number;
          blocklistedMovies: number;
          blocklistedShows: number;
        };
      } = {
        radarr: [],
        sonarr: [],
        summary: {
          totalItems: 0,
          totalSize: 0,
          blocklistedMovies: 0,
          blocklistedShows: 0,
        },
      };

      const blocklistRepository = getRepository(Blocklist);

      const radarrServers = uniqWith(
        settings.radarr.filter((server) => server.syncEnabled !== false),
        (a, b) =>
          a.hostname === b.hostname &&
          a.port === b.port &&
          a.baseUrl === b.baseUrl
      );

      const blocklistedMovies = await blocklistRepository.find({
        where: { mediaType: MediaType.MOVIE },
        select: ['tmdbId', 'title', 'blocklistedTags'],
      });

      violations.summary.blocklistedMovies = blocklistedMovies.length;

      const movieBlocklistMap = new Map(
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
          const radarr = new RadarrAPI({
            apiKey: server.apiKey,
            url: RadarrAPI.buildUrl(server, '/api/v3'),
          });

          const radarrMovies = await radarr.getMovies();
          const serverViolations: ViolationItem[] = [];
          let totalSize = 0;

          for (const movie of radarrMovies) {
            if (movie.tmdbId && movieBlocklistMap.has(movie.tmdbId)) {
              const blocklistInfo = movieBlocklistMap.get(movie.tmdbId);
              const movieSize = movie.movieFile?.size || 0;

              serverViolations.push({
                title: movie.title,
                tmdbId: movie.tmdbId,
                arrId: movie.id,
                sizeOnDisk: movieSize,
                added: movie.added ? new Date(movie.added) : undefined,
                monitored: movie.monitored,
                blocklistSource: blocklistInfo?.source,
              });

              totalSize += movieSize;
            }
          }

          violations.radarr.push({
            serverName: server.name,
            serverId: server.id,
            serverType: 'radarr',
            items: serverViolations,
            totalSize,
          });

          violations.summary.totalItems += serverViolations.length;
          violations.summary.totalSize += totalSize;
        } catch (error) {
          logger.error('Error checking Radarr server', {
            label: 'Blocklist API',
            serverName: server.name,
            error: error.message,
          });
        }
      }

      const sonarrServers = uniqWith(
        settings.sonarr.filter((server) => server.syncEnabled !== false),
        (a, b) =>
          a.hostname === b.hostname &&
          a.port === b.port &&
          a.baseUrl === b.baseUrl
      );

      const blocklistedShows = await blocklistRepository.find({
        where: { mediaType: MediaType.TV },
        select: ['tmdbId', 'title', 'blocklistedTags'],
      });

      violations.summary.blocklistedShows = blocklistedShows.length;

      logger.info('Blocklist discovery completed', {
        label: 'Blocklist API',
        violations: violations.summary,
      });

      return res.status(200).json(violations);
    } catch (error) {
      logger.error('Blocklist discovery failed', {
        label: 'Blocklist API',
        error: error.message,
      });
      return res.status(500).json({
        error: 'Failed to discover blocklist violations',
        message: error.message,
      });
    }
  }
);

export default blocklistRoutes;
