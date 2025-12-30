# Feature: Blocklist Sync & Automatic Enforcement

**Commit:** 6fd9d7b5  
**Date:** December 30, 2025  
**Type:** feat(blacklist)  
**Status:** ✅ Production Ready

---

## Summary

Bidirectional synchronization between Seerr's blacklist database and Radarr/Sonarr exclusion lists with automatic enforcement. Prevents blocklisted media from being requested and automatically removes violations from arr services.

---

## User-Facing Behavior

### Settings UI
**Location:** Settings → Radarr/Sonarr

**New Controls:**
1. **"Enforce Blocklist" checkbox** per server
   - When enabled: Automatically removes blocklisted media from that arr service
   - When disabled: Sync only (no automatic deletion)

2. **Blocklist Sync Status** (Settings → Main)
   - Shows last sync time
   - Manual sync trigger button
   - Sync interval configuration

### Request Blocking
- Attempting to request blocklisted media shows error: "This media is blacklisted"
- Error message indicates source (Radarr/Sonarr/Manual)
- Prevents wasted requests and quota usage

### Automatic Enforcement
- Hourly job scans Radarr/Sonarr for blocklisted items
- Automatically removes violations (with files)
- Logs all enforcement actions
- Preserves items synced FROM arr services (tagged appropriately)

---

## Technical Implementation

### Architecture

**3-Way Sync System:**
```
Seerr Blacklist (Database)
    ↕️ 
Radarr Exclusions ↔ Sonarr Exclusions
```

**Sync Directions:**
1. **Radarr/Sonarr → Seerr:** Import exclusions as blacklist entries (tag: `radarr-sync-*` / `sonarr-sync-*`)
2. **Seerr → Radarr/Sonarr:** Export blacklist as exclusions
3. **Cleanup:** Remove exclusions for items no longer in Seerr blacklist

### Key Components

**Core Sync Engine:** `server/lib/blocklistSync.ts` (~991 lines)
- `syncBlocklistFromRadarr()` - Import Radarr exclusions
- `syncBlocklistFromSonarr()` - Import Sonarr exclusions  
- `syncBlocklistToRadarr()` - Export to Radarr
- `syncBlocklistToSonarr()` - Export to Sonarr
- `cleanupRemovedBlacklistItems()` - Remove stale exclusions
- `enforceBlocklist()` - Remove violations if enforcement enabled

**Arr-Specific Handlers:**
- `server/lib/radarrBlocklist.ts` - Radarr exclusion management
- `server/lib/sonarrBlocklist.ts` - Sonarr exclusion management

**API Endpoints:** `server/routes/settings/blocklist.ts`
- `GET /api/v1/settings/blocklist/violations` - Discover violations
- `POST /api/v1/settings/blocklist/sync` - Manual sync trigger

**Scheduled Job:** `server/job/blocklistSync.ts`
- Default: Hourly (configurable)
- Cron: `0 0 */1 * * *` (every hour)
- Can be triggered manually via API

**Discovery Script:** `server/scripts/discoverBlacklistViolations.ts`
- CLI tool: `pnpm blacklist:discover`
- Read-only analysis of violations
- Useful for auditing before enabling enforcement

### Database Schema

**Blacklist Table:**
- `tmdbId` - The Movie Database ID
- `mediaType` - 'movie' or 'tv'
- `title` - Media title
- `blacklistedTags` - Source tracking (e.g., 'radarr-sync-servername', 'manual', 'auto-deleted')
- `userId` - Who added it (nullable for system-added)
- `createdAt` - When added

### Settings Schema

**Added to RadarrSettings / SonarrSettings:**
```typescript
enforceBlocklist?: boolean;  // Enable automatic enforcement
```

**Added to MainSettings:**
```typescript
blocklistSyncEnabled?: boolean;  // Enable sync job
blocklistSyncInterval?: number;  // Minutes between syncs (default: 60)
```

### Request Flow Integration

**MediaRequest.request() Enhancement:**
```typescript
// Check Seerr blacklist before creating request
const seerrBlacklisted = await blacklistRepository.findOne({
  where: { tmdbId: requestBody.mediaId, mediaType: requestBody.mediaType }
});

if (seerrBlacklisted) {
  throw new BlacklistedMediaError('This media is blacklisted.');
}
```

### API Methods Added

**Radarr API:**
- `deleteExclusion(id: number)` - Remove exclusion by ID

**Sonarr API:**
- `deleteExclusion(id: number)` - Remove exclusion by ID

### Logging & Monitoring

**Enhanced Auth Logging:**
- API key authentication attempts
- User load events
- Permission check failures
- Useful for debugging and security auditing

---

## Files Changed (20 files)

### New Files (6)
- `server/job/blocklistSync.ts` - Scheduled sync job
- `server/lib/blocklistSync.ts` - Core sync logic (~991 lines)
- `server/lib/radarrBlocklist.ts` - Radarr handler
- `server/lib/sonarrBlocklist.ts` - Sonarr handler
- `server/routes/settings/blocklist.ts` - API endpoints
- `server/scripts/discoverBlacklistViolations.ts` - Discovery CLI tool

### Modified Files (14)
- `package.json` - Add `blacklist:discover` script
- `server/api/servarr/radarr.ts` - Add deleteExclusion method
- `server/api/servarr/sonarr.ts` - Add deleteExclusion method
- `server/entity/MediaRequest.ts` - Add blacklist check in request flow
- `server/job/schedule.ts` - Register blocklist-sync job
- `server/lib/settings/index.ts` - Add enforcement settings
- `server/lib/watchlistsync.ts` - Integration point
- `server/middleware/auth.ts` - Enhanced logging
- `server/routes/settings/index.ts` - Register blocklist routes
- `server/routes/settings/radarr.ts` - Enforcement setting backend
- `server/routes/settings/sonarr.ts` - Enforcement setting backend
- `src/components/Settings/RadarrModal/index.tsx` - Enforcement checkbox UI
- `src/components/Settings/SettingsMain/index.tsx` - Sync controls UI
- `src/components/Settings/SonarrModal/index.tsx` - Enforcement checkbox UI

---

## Testing

### Manual Sync Test
```bash
API_KEY="your-api-key"
curl -X POST 'http://localhost:5055/api/v1/settings/blocklist/sync' \
  -H 'X-Api-Key: $API_KEY' \
  -d '{"start": true}'
```

### Discovery Script
```bash
cd /Users/fabian/projects/seerr
pnpm blacklist:discover
```

### Enforcement Test
1. Add item to Seerr blacklist
2. Enable "Enforce Blocklist" in Radarr settings
3. Wait for hourly job or trigger manually
4. Verify item removed from Radarr

### Request Blocking Test
1. Add movie to blacklist
2. Try to request it
3. Should see error: "This media is blacklisted"

---

## Rollback Notes

If issues occur:
```bash
# Disable enforcement
Settings → Radarr/Sonarr → Uncheck "Enforce Blocklist"

# Disable sync job
Settings → Main → Set blocklistSyncEnabled = false

# Revert code
git checkout backup/messy-develop-20251230
```

---

## Known Issues / Future Improvements

1. **OpenAPI Spec Missing:** `/settings/blocklist/violations` endpoint not in seerr-api.yml (returns 404 via validator)
2. **No UI for Violations:** Discovery only via API/script
3. **No Undo:** Enforcement deletes immediately (consider confirmation)
4. **Performance:** Large libraries may have slow initial sync

---

## Dependencies

None - Standalone feature

---

## Related Features

- **Auto-Delete Feature:** Uses `Blacklist.addToBlacklist()` to prevent re-requesting

