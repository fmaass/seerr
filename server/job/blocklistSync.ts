import blocklistSyncService from '@server/lib/blocklistSync';
import { getSettings } from '@server/lib/settings';
import type { RunnableScanner, StatusBase } from '@server/lib/scanners/baseScanner';
import logger from '@server/logger';

class BlocklistSyncJob implements RunnableScanner<StatusBase> {
  private running = false;

  public async run(): Promise<void> {
    if (this.running) {
      logger.warn('Blocklist sync already running, skipping', {
        label: 'Blocklist Sync Job',
      });
      return;
    }

    this.running = true;

    try {
      logger.info('Starting scheduled job: Blocklist Sync', {
        label: 'Jobs',
      });

      await Promise.all([
        blocklistSyncService.syncAllRadarrServers(),
        blocklistSyncService.syncAllSonarrServers(),
      ]);

      await Promise.all([
        blocklistSyncService.syncSeerrToRadarr(),
        blocklistSyncService.syncSeerrToSonarr(),
      ]);

      await Promise.all([
        blocklistSyncService.syncRadarrExclusionRemovals(),
        blocklistSyncService.syncSonarrExclusionRemovals(),
      ]);

      await blocklistSyncService.enforceRadarrBlocklist();

      logger.info('Completed scheduled job: Blocklist Sync', {
        label: 'Jobs',
      });
    } catch (e) {
      logger.error('Error running blocklist sync job', {
        label: 'Blocklist Sync Job',
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

const blocklistSyncJob = new BlocklistSyncJob();
export default blocklistSyncJob;
