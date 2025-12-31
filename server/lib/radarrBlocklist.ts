import RadarrAPI from '@server/api/servarr/radarr';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { uniqWith } from 'lodash';

class RadarrBlocklistService {
  /**
   * Check if a movie (by TMDB ID) is blocklisted in any configured Radarr server
   * @param tmdbId The TMDB ID of the movie to check
   * @param is4k Whether to check 4K servers (false = check non-4K servers)
   * @returns true if the movie is blocklisted, false otherwise
   */
  public async isMovieBlocklisted(
    tmdbId: number,
    is4k: boolean = false
  ): Promise<boolean> {
    const settings = getSettings();

    // Get unique Radarr servers (filter duplicates)
    const radarrServers = uniqWith(
      settings.radarr.filter((server) => server.is4k === is4k),
      (radarrA, radarrB) =>
        radarrA.hostname === radarrB.hostname &&
        radarrA.port === radarrB.port &&
        radarrA.baseUrl === radarrB.baseUrl
    );

    if (radarrServers.length === 0) {
      logger.debug('No Radarr servers configured for blocklist check', {
        label: 'Radarr Blocklist',
        tmdbId,
        is4k,
      });
      return false;
    }

    // Check each Radarr server
    for (const server of radarrServers) {
      try {
        logger.debug('Checking Radarr blocklist', {
          label: 'Radarr Blocklist',
          serverName: server.name,
          serverId: server.id,
          tmdbId,
          is4k,
        });

        const radarrAPI = new RadarrAPI({
          apiKey: server.apiKey,
          url: RadarrAPI.buildUrl(server, '/api/v3'),
        });

        const isBlocklisted = await radarrAPI.isMovieBlocklisted(tmdbId);

        if (isBlocklisted) {
          logger.warn('Movie is blocklisted in Radarr', {
            label: 'Radarr Blocklist',
            serverName: server.name,
            serverId: server.id,
            tmdbId,
            is4k,
          });
          return true;
        }

        logger.debug('Movie not found in Radarr blocklist', {
          label: 'Radarr Blocklist',
          serverName: server.name,
          serverId: server.id,
          tmdbId,
          is4k,
        });
      } catch (e) {
        logger.error('Error checking Radarr blocklist', {
          label: 'Radarr Blocklist',
          serverName: server.name,
          serverId: server.id,
          tmdbId,
          is4k,
          errorMessage: e.message,
        });
        // Continue checking other servers even if one fails
      }
    }

    return false;
  }
}

const radarrBlocklistService = new RadarrBlocklistService();
export default radarrBlocklistService;
