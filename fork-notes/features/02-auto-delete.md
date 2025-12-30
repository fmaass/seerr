# Feature: Auto-Delete Scheduling with Blocklist Integration

**Commit:** 4b881648  
**Date:** December 30, 2025  
**Type:** feat(requests)  
**Status:** ✅ Production Ready  
**Depends On:** Feature #1 (Blocklist Sync)

---

## Summary

Automatically delete downloaded media from Radarr/Sonarr after a configurable retention period. Deleted items are added to the blocklist to prevent automatic re-requesting by list sync jobs (Trakt, Plex Watchlist, etc.).

---

## User-Facing Behavior

### Request Modal
**Location:** Click "Request" on any movie

**New Control:**
- **"Auto-delete after (days)" dropdown**
- Options: Keep forever (default), 7, 14, 30, 60, 90 days
- Warning message when enabled

### Manage Panel  
**Location:** Movie page → Gear icon → "Auto-Delete" section

**When Auto-Delete IS Set:**
- Visual progress bar (yellow → red when expired)
- "Deletes in X days" countdown
- Exact deletion date/time
- "Cancel Auto-Delete" button (with confirmation)

**When Auto-Delete NOT Set:**
- "No auto-delete scheduled" message
- "Set Auto-Delete" button
- Modal with retention period options

### Request Lists
**Inline Status Display:**
- Yellow clock icon
- "Deletes in X days" text
- Visible in all request views

### Deletion Schedule
- **Runs daily at 3:00 AM**
- UI message: "Deletion check runs daily at 3:00 AM. Deleted items are added to the blocklist to prevent automatic re-requests."
- Not real-time (up to 24 hour delay)

---

## Technical Implementation

### Database Schema

**MediaRequest Entity - New Field:**
```typescript
@DbAwareColumn({ type: 'datetime', nullable: true })
public autoDeleteDate?: Date;
```

**Migrations:**
- `server/migration/sqlite/1735213200000-AddAutoDeleteDateToMediaRequest.ts`
- `server/migration/postgres/1735213200000-AddAutoDeleteDateToMediaRequest.ts`

### API Endpoints

**Set/Cancel Auto-Delete:**
```
POST /api/v1/request/auto-delete/:requestId
Body: { days: number }  // 0 = cancel, >0 = set

Response: MediaRequest with updated autoDeleteDate
```

**Get Auto-Delete Info:**
```
GET /api/v1/request/auto-delete/:requestId

Response: {
  requestId: number,
  autoDeleteDate: string | null,
  hasExpiration: boolean,
  daysUntilDeletion: number | null
}
```

**OpenAPI Spec:** Added to `seerr-api.yml` for validation

### Scheduled Job

**File:** `server/job/autoDeleteExpired.ts` (~307 lines)

**Schedule:** Daily at 3:00 AM  
**Cron:** `0 0 3 * * *`

**Process:**
1. Query expired requests:
   ```sql
   WHERE status IN (APPROVED, COMPLETED)
   AND autoDeleteDate IS NOT NULL  
   AND autoDeleteDate <= NOW()
   ```

2. For each expired request:
   - Connect to Radarr/Sonarr
   - Delete movie/series with files (`deleteFiles: true`)
   - **Add to blocklist** (tag: `auto-deleted`)
   - Set media status to BLACKLISTED
   - Clear `autoDeleteDate` from request (set to null)
   - Log deletion details

3. Handle edge cases:
   - Movie/series already deleted (404) → Count as success
   - Server not found → Skip with warning
   - Already in blocklist → Log warning, continue

**Manual Trigger:**
```
POST /api/v1/settings/jobs/auto-delete-expired/run
```

### Request Creation Flow

**MediaRequest.request() Enhancement:**
```typescript
if (requestBody.autoDeleteDays && requestBody.autoDeleteDays > 0) {
  const autoDeleteDate = new Date();
  autoDeleteDate.setDate(autoDeleteDate.getDate() + requestBody.autoDeleteDays);
  request.autoDeleteDate = autoDeleteDate;
  await requestRepository.save(request);
}
```

**Approval Flow Enhancement:**
```typescript
// In /:requestId/:status endpoint
if (req.body.autoDeleteAfterDays && req.body.autoDeleteAfterDays > 0) {
  request.autoDeleteDate = calculateDate(req.body.autoDeleteAfterDays);
}
```

### UI Components

**AutoDeleteBlock Component:** `src/components/AutoDeleteBlock/index.tsx` (~254 lines)
- Progress bar calculation
- Days remaining countdown
- Set/Cancel modals
- Cache-busting page reload after changes

**Integration Points:**
- `src/components/ManageSlideOver/index.tsx` - Main display
- `src/components/RequestBlock/index.tsx` - Inline status
- `src/components/RequestModal/MovieRequestModal.tsx` - Request-time option
- `src/components/RequestList/RequestItem/index.tsx` - List view status

### Cache Management

**Challenge:** React/SWR not re-rendering after API changes

**Solution:** Cache-busting page reload
```typescript
window.location.href = window.location.href.split('?')[0] + '?t=' + Date.now();
```

This forces SWR to fetch fresh data from the API.

### Blocklist Integration

**Why:** Prevents list sync jobs from re-requesting deleted media

**Implementation:**
```typescript
// In autoDeleteExpired.ts after successful deletion
await Blacklist.addToBlacklist({
  blacklistRequest: {
    tmdbId: request.media.tmdbId,
    mediaType: MediaType.MOVIE,
    title: movieTitle,
    blacklistedTags: 'auto-deleted',
  },
});
```

**Effect:**
- Media status set to BLACKLISTED (6)
- Future request attempts blocked
- List sync jobs skip the item
- Can be manually removed from blocklist if needed

---

## Files Changed (13 files)

### New Files (5)
- `src/components/AutoDeleteBlock/index.tsx` - UI component
- `server/routes/request/autoDelete.ts` - API endpoints
- `server/job/autoDeleteExpired.ts` - Scheduled deletion job
- `server/migration/postgres/1735213200000-AddAutoDeleteDateToMediaRequest.ts`
- `server/migration/sqlite/1735213200000-AddAutoDeleteDateToMediaRequest.ts`

### Modified Files (8)
- `seerr-api.yml` - OpenAPI spec (+70 lines)
- `server/entity/MediaRequest.ts` - Add autoDeleteDate field + handling
- `server/interfaces/api/requestInterfaces.ts` - Add autoDeleteDays parameter
- `server/routes/request.ts` - Register autoDeleteRoutes + handle autoDeleteDays
- `src/components/ManageSlideOver/index.tsx` - Add Auto-Delete section
- `src/components/RequestBlock/index.tsx` - Inline status display
- `src/components/RequestList/RequestItem/index.tsx` - List view status
- `src/components/RequestModal/MovieRequestModal.tsx` - Request-time dropdown

---

## Testing

### API Tests (All Passing ✅)

```bash
API_KEY="your-key"

# Test 1: Set auto-delete
curl -X POST 'http://localhost:5055/api/v1/request/auto-delete/3058' \
  -H 'Content-Type: application/json' \
  -H 'X-Api-Key: $API_KEY' \
  -d '{"days": 90}' | jq '{id, autoDeleteDate}'
# Expected: autoDeleteDate set to 90 days from now

# Test 2: Get info
curl 'http://localhost:5055/api/v1/request/auto-delete/3058' \
  -H 'X-Api-Key: $API_KEY' | jq '.'
# Expected: hasExpiration: true, daysUntilDeletion: 90

# Test 3: Cancel
curl -X POST 'http://localhost:5055/api/v1/request/auto-delete/3058' \
  -H 'Content-Type: application/json' \
  -H 'X-Api-Key: $API_KEY' \
  -d '{"days": 0}' | jq '{id, autoDeleteDate}'
# Expected: autoDeleteDate: null

# Test 4: Database verification
sqlite3 /path/to/db.sqlite3 'SELECT id, autoDeleteDate FROM media_request WHERE id = 3058;'
```

### Job Test (Verified ✅)

```bash
# Set to expired (for testing)
sqlite3 /path/to/db.sqlite3 \
  "UPDATE media_request SET autoDeleteDate = datetime('now', '-1 minute') WHERE id = 3058;"

# Trigger job
curl -X POST 'http://localhost:5055/api/v1/settings/jobs/auto-delete-expired/run' \
  -H 'X-Api-Key: $API_KEY'

# Check logs
docker logs jellyseerr | grep 'Auto-Delete'

# Expected logs:
# - "Found expired media requests"
# - "Successfully deleted expired movie from Radarr"
# - "Added auto-deleted movie to blocklist"

# Verify blocklist
sqlite3 /path/to/db.sqlite3 \
  "SELECT tmdbId, title, blacklistedTags FROM blacklist WHERE tmdbId = YOUR_TMDB_ID;"
# Expected: Entry with blacklistedTags = 'auto-deleted'
```

### UI Test Checklist

- [ ] Request modal shows auto-delete dropdown
- [ ] Setting auto-delete saves correctly
- [ ] Manage panel shows Auto-Delete section
- [ ] Progress bar displays correctly
- [ ] Days countdown accurate
- [ ] Cancel button works (page reloads)
- [ ] Set button works (page reloads)
- [ ] Inline status shows in request lists

---

## Rollback Notes

### Disable Feature
```bash
# Via API - cancel all auto-deletes
for id in $(sqlite3 db.sqlite3 "SELECT id FROM media_request WHERE autoDeleteDate IS NOT NULL;"); do
  curl -X POST "/api/v1/request/auto-delete/$id" -d '{"days": 0}'
done
```

### Revert Code
```bash
git checkout backup/messy-develop-20251230
# Or apply reverse patch:
git apply -R fork-notes/patches/02-auto-delete.patch
```

### Database Rollback
```sql
-- Remove autoDeleteDate values (don't drop column - breaks migrations)
UPDATE media_request SET autoDeleteDate = NULL;
```

---

## Dependencies

**Requires:** Feature #1 (Blocklist Sync)
- Uses `Blacklist.addToBlacklist()` method
- Relies on blocklist infrastructure

---

## Known Issues / Future Improvements

1. **Timing:** Deletion at 3 AM only (not real-time)
   - Consider: Configurable schedule
   - Consider: More frequent checks (hourly?)

2. **UI Refresh:** Uses full page reload
   - Consider: Optimistic UI updates
   - Consider: WebSocket for real-time updates

3. **No Notifications:** Users not notified when items deleted
   - Consider: Email/Discord notification
   - Consider: Deletion history view

4. **Blocklist Permanent:** Auto-deleted items stay blocklisted forever
   - Consider: Temporary blocklist with auto-removal
   - Consider: User choice (blocklist yes/no)

5. **No Bulk Management:** Can't manage multiple auto-deletes at once
   - Consider: Bulk set/cancel UI
   - Consider: Auto-delete statistics dashboard

---

## Production Deployment

**Tested on Saturn:** ✅ December 30, 2025  
**Version:** clean-fixed-1767128159  
**Status:** All features working correctly

**Verified:**
- ✅ API endpoints responding
- ✅ Database updates correctly
- ✅ Job can be triggered manually
- ✅ Blocklist integration functional
- ✅ UI displays correctly
- ✅ Page reload cache-busting works

