# FEATURE ANALYSIS - COMPLETE BREAKDOWN

## FEATURE #1: Blocklist Sync & Enforcement
**Commits:** dee5c3e6 → a350584e (first 24 commits, excluding fc7a2e1d)
**Purpose:** 2-way sync between Seerr blacklist and Radarr/Sonarr exclusions with enforcement

### Files to Include:
NEW:
- server/job/blocklistSync.ts
- server/lib/blocklistSync.ts
- server/lib/radarrBlocklist.ts
- server/lib/sonarrBlocklist.ts
- server/routes/settings/blocklist.ts
- server/scripts/discoverBlacklistViolations.ts

MODIFIED:
- package.json (add blacklist:discover script)
- server/api/servarr/radarr.ts (exclusion delete methods)
- server/api/servarr/sonarr.ts (exclusion delete methods)
- server/entity/MediaRequest.ts (blacklist enforcement in request)
- server/job/blacklistedTagsProcessor.ts (integration)
- server/job/schedule.ts (register job)
- server/lib/settings/index.ts (enforcement settings)
- server/lib/watchlistsync.ts (integration)
- server/routes/settings/index.ts (register routes)
- server/routes/settings/radarr.ts (enforcement UI backend)
- server/routes/settings/sonarr.ts (enforcement UI backend)
- src/components/Settings/RadarrModal/index.tsx (enforcement checkbox)
- src/components/Settings/SonarrModal/index.tsx (enforcement checkbox)
- src/components/Settings/SettingsMain/index.tsx (sync controls)

EXCLUDE:
- server/middleware/auth.ts (check if changed for this feature)
- server/routes/auth.ts (upstream cherry-pick fc7a2e1d)

## FEATURE #2: Auto-Delete with Blocklist Integration
**Commits:** 0b87e476 → aff2f29c (last 23 commits)
**Purpose:** Auto-delete media after retention period + add to blocklist

### Files to Include:
NEW (from stash + origin):
- src/components/AutoDeleteBlock/index.tsx (IN STASH)
- server/routes/request/autoDelete.ts (IN STASH - updated)
- server/job/autoDeleteExpired.ts (IN STASH - with blocklist)
- server/migration/postgres/1735213200000-AddAutoDeleteDateToMediaRequest.ts
- server/migration/sqlite/1735213200000-AddAutoDeleteDateToMediaRequest.ts

MODIFIED (from stash + origin):
- server/entity/MediaRequest.ts (autoDeleteDate field)
- server/routes/request.ts (autoDeleteDays handling - IN STASH)
- server/job/schedule.ts (register auto-delete job)
- server/lib/settings/index.ts (job schedule)
- server/interfaces/api/requestInterfaces.ts (autoDeleteDays)
- src/components/ManageSlideOver/index.tsx (IN STASH - Auto-Delete section)
- src/components/RequestBlock/index.tsx (IN STASH - inline status)
- src/components/RequestModal/MovieRequestModal.tsx (auto-delete dropdown)
- src/components/RequestList/RequestItem/index.tsx (check if needed)
- seerr-api.yml (IN STASH - OpenAPI spec)

EXCLUDE:
- server/index.ts (migrations disabled - temporary hack)
- Dockerfile.local (dev environment)
- compose.yaml (dev environment)
- .gitignore (fork docs)
- DEPLOYMENT.md (fork only)
- AUTO_DELETE_FEATURE.md (fork only)
- BLACKLIST-FIX-SUMMARY.txt (temp file)
