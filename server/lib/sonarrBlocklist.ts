import SonarrAPI from '@server/api/servarr/sonarr';
import { getSettings, type SonarrSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { uniqWith } from 'lodash';

class SonarrBlocklistService {
  public async isSeriesBlocklisted(
    tvdbId: number,
    is4k: boolean = false
  ): Promise<boolean> {
    const settings = getSettings();

    const sonarrServers = uniqWith(
      settings.sonarr.filter((server) => server.is4k === is4k),
      (sonarrA, sonarrB) =>
        sonarrA.hostname === sonarrB.hostname &&
        sonarrA.port === sonarrB.port &&
        sonarrA.baseUrl === sonarrB.baseUrl
    );

    if (sonarrServers.length === 0) {
      logger.debug('No Sonarr servers configured for blocklist check', {
        label: 'Sonarr Blocklist',
        tvdbId,
        is4k,
      });
      return false;
    }

    for (const server of sonarrServers) {
      try {
        logger.debug('Checking Sonarr blocklist', {
          label: 'Sonarr Blocklist',
          serverName: server.name,
          serverId: server.id,
          tvdbId,
          is4k,
        });

        const sonarrAPI = new SonarrAPI({
          apiKey: server.apiKey,
          url: SonarrAPI.buildUrl(server, '/api/v3'),
        });

        const isBlocklisted = await sonarrAPI.isSeriesBlocklisted(tvdbId);

        if (isBlocklisted) {
          logger.warn('Series is blocklisted in Sonarr', {
            label: 'Sonarr Blocklist',
            serverName: server.name,
            serverId: server.id,
            tvdbId,
            is4k,
          });
          return true;
        }

        logger.debug('Series not found in Sonarr blocklist', {
          label: 'Sonarr Blocklist',
          serverName: server.name,
          serverId: server.id,
          tvdbId,
          is4k,
        });
      } catch (e) {
        logger.error('Error checking Sonarr blocklist', {
          label: 'Sonarr Blocklist',
          serverName: server.name,
          serverId: server.id,
          tvdbId,
          is4k,
          errorMessage: e.message,
        });
      }
    }

    return false;
  }
}

const sonarrBlocklistService = new SonarrBlocklistService();
export default sonarrBlocklistService;
