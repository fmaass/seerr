import { Router } from 'express';
import { getRepository } from '@server/datasource';
import { Blacklist } from '@server/entity/Blacklist';
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
  blacklistSource?: string;
}

interface ServerViolations {
  serverName: string;
  serverId: number;
  serverType: 'radarr' | 'sonarr';
  items: ViolationItem[];
  totalSize: number;
}

/**
 * GET /api/v1/settings/blocklist/discover
 * Discover items in Radarr/Sonarr that violate Seerr blacklist
 * 
 * @returns Discovery report with violations
 */
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
          blacklistedMovies: number;
          blacklistedShows: number;
        };
      } = {
        radarr: [],
        sonarr: [],
        summary: {
          totalItems: 0,
          totalSize: 0,
          blacklistedMovies: 0,
          blacklistedShows: 0,
        },
      };

      // Get blacklist from database
      const blacklistRepository = getRepository(Blacklist);

      // Discover Radarr violations
      const radarrServers = uniqWith(
        settings.radarr.filter((server) => server.syncEnabled !== false),
        (a, b) =>
          a.hostname === b.hostname &&
          a.port === b.port &&
          a.baseUrl === b.baseUrl
      );

      const blacklistedMovies = await blacklistRepository.find({
        where: { mediaType: MediaType.MOVIE },
        select: ['tmdbId', 'title', 'blacklistedTags'],
      });

      violations.summary.blacklistedMovies = blacklistedMovies.length;

      const movieBlacklistMap = new Map(
        blacklistedMovies.map((item) => [
          item.tmdbId,
          {
            title: item.title,
            source: item.blacklistedTags,
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
            if (movie.tmdbId && movieBlacklistMap.has(movie.tmdbId)) {
              const blacklistInfo = movieBlacklistMap.get(movie.tmdbId);
              const movieSize = movie.movieFile?.size || 0;

              serverViolations.push({
                title: movie.title,
                tmdbId: movie.tmdbId,
                arrId: movie.id,
                sizeOnDisk: movieSize,
                added: movie.added ? new Date(movie.added) : undefined,
                monitored: movie.monitored,
                blacklistSource: blacklistInfo?.source,
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

      // Discover Sonarr violations (similar structure)
      const sonarrServers = uniqWith(
        settings.sonarr.filter((server) => server.syncEnabled !== false),
        (a, b) =>
          a.hostname === b.hostname &&
          a.port === b.port &&
          a.baseUrl === b.baseUrl
      );

      const blacklistedShows = await blacklistRepository.find({
        where: { mediaType: MediaType.TV },
        select: ['tmdbId', 'title', 'blacklistedTags'],
      });

      violations.summary.blacklistedShows = blacklistedShows.length;

      // Note: Sonarr uses TVDB, would need TMDB->TVDB mapping for full implementation

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

