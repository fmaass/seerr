# Seerr Deployment Workflow - APPROVED PROCESS

**Last Updated:** December 30, 2025  
**Status:** ✅ Mandatory for all deployments

---

## ⚠️ CRITICAL RULE

**SSH file copying (`cat file | ssh saturn.local "cat > file"`) is FORBIDDEN as normal procedure.**

**Approved Route ONLY:**
```
Feature Branch → Commit → Push (optional) → Pull on Saturn → Build → Deploy
```

---

## Standard Deployment Workflow

### Step 1: Develop on Feature Branch

```bash
cd /Users/fabian/projects/seerr

# Create feature branch from clean baseline
git checkout -b feature/my-feature clean/develop
# OR from upstream if contributing upstream
git checkout -b feature/my-feature upstream/develop

# Make changes
# ... edit files ...

# Commit atomically
git add <files>
git commit -m "feat(scope): description"
```

### Step 2: Test Locally (Optional)

```bash
# Build Docker image
docker build \
  --platform linux/amd64 \
  --build-arg COMMIT_TAG=$(git rev-parse HEAD) \
  -t seerr-radarr-blocklist:test \
  -f Dockerfile \
  .

# Test locally if needed
docker run -p 5055:5055 -v $(pwd)/config:/app/config seerr-radarr-blocklist:test
```

### Step 3: Push to Fork (Optional but Recommended)

```bash
# Push feature branch to origin
git push origin feature/my-feature

# Tag for deployment tracking
git tag deploy/saturn/$(date +%Y%m%d-%H%M%S)
git push origin --tags
```

### Step 4: Sync to Saturn

**Option A: Via Git (Recommended)**
```bash
# On Saturn: Pull the feature branch
ssh saturn.local "cd /volume1/docker/seerr-custom && git fetch origin && git checkout feature/my-feature"
```

**Option B: Build Locally & Transfer Image**
```bash
# Build on Mac
docker build --platform linux/amd64 -t seerr-radarr-blocklist:test -f Dockerfile .

# Transfer to Saturn
docker save seerr-radarr-blocklist:test | gzip | \
  ssh saturn.local "cat > /volume1/docker/seerr-deploy.tar.gz"

# Load on Saturn
ssh saturn.local "sudo /usr/local/bin/docker load < /volume1/docker/seerr-deploy.tar.gz && \
  rm /volume1/docker/seerr-deploy.tar.gz"
```

### Step 5: Deploy on Saturn

```bash
# Restart container with new image
ssh saturn.local "cd /volume1/docker-compose/stacks/sonarr-radarr && \
  sudo /usr/local/bin/docker-compose up -d --force-recreate jellyseerr"

# Verify deployment
ssh saturn.local "sudo /usr/local/bin/docker logs jellyseerr --tail 20"
```

### Step 6: Verify Production

```bash
# Check version
curl -s https://requests.discomarder.live/api/v1/status | jq '{version, commitTag}'

# Check logs for errors
ssh saturn.local "sudo /usr/local/bin/docker logs jellyseerr --since 5m | grep -i error"
```

---

## Emergency Procedure (LAST RESORT ONLY)

**When Allowed:**
- Production is down and Git workflow too slow
- Critical security patch needed immediately
- Database corruption requires manual intervention

**Required Steps:**

1. **Document the Emergency**
   ```bash
   # Create incident log
   echo "EMERGENCY DEPLOYMENT - $(date)" > /tmp/emergency-$(date +%s).log
   echo "Reason: [DESCRIBE CRITICAL ISSUE]" >> /tmp/emergency-$(date +%s).log
   echo "Files modified:" >> /tmp/emergency-$(date +%s).log
   ```

2. **Record Diffs BEFORE Copying**
   ```bash
   # For each file being copied
   ssh saturn.local "cat /volume1/docker/seerr-custom/path/to/file.ts" > /tmp/before-file.ts
   diff -u /tmp/before-file.ts local/file.ts > /tmp/emergency-diff-file.patch
   ```

3. **Perform Emergency Copy**
   ```bash
   cat local/file.ts | ssh saturn.local "cat > /volume1/docker/seerr-custom/path/to/file.ts"
   ```

4. **Immediate Audit Trail**
   ```bash
   # Commit the changes on Saturn
   ssh saturn.local "cd /volume1/docker/seerr-custom && \
     git add -A && \
     git commit -m 'emergency: [DESCRIBE] - $(date)' && \
     git log -1 --stat"
   ```

5. **Document in Git**
   ```bash
   # On local machine: commit the same changes
   git add <files>
   git commit -m "emergency: [DESCRIBE] - deployed via SSH on $(date)

   Emergency deployment bypassed normal workflow due to [REASON].
   
   Files modified via SSH:
   - path/to/file.ts
   
   Incident log: /tmp/emergency-TIMESTAMP.log
   Diffs recorded: /tmp/emergency-diff-*.patch
   
   Saturn commit: [COMMIT_SHA from step 4]"
   
   # Push immediately
   git push origin HEAD
   ```

6. **Post-Incident Review**
   - Document what went wrong with normal process
   - Update procedures to prevent future emergencies
   - Consider automation improvements

---

## Rollback Procedures

### Rollback to Previous Version

```bash
# On Saturn: Find previous image
ssh saturn.local "sudo /usr/local/bin/docker images seerr-radarr-blocklist --format '{{.ID}} {{.CreatedAt}}' | head -5"

# Tag previous image
ssh saturn.local "sudo /usr/local/bin/docker tag OLD_IMAGE_ID seerr-radarr-blocklist:test"

# Restart
ssh saturn.local "cd /volume1/docker-compose/stacks/sonarr-radarr && \
  sudo /usr/local/bin/docker-compose up -d --force-recreate jellyseerr"
```

### Rollback via Git

```bash
# On Saturn: checkout previous commit
ssh saturn.local "cd /volume1/docker/seerr-custom && \
  git log --oneline -5 && \
  git checkout PREVIOUS_COMMIT"

# Rebuild and deploy
# ... follow standard workflow ...
```

---

## Deployment Checklist

Before deploying to production:

- [ ] Feature branch created from clean baseline
- [ ] Changes committed with Conventional Commits format
- [ ] Local build successful (`docker build`)
- [ ] Tests pass (if applicable)
- [ ] No linter errors
- [ ] Deployment tagged for tracking
- [ ] Saturn synced via Git (not SSH copy)
- [ ] Container restarted successfully
- [ ] Logs checked for errors
- [ ] API responding correctly
- [ ] UI tested in browser
- [ ] Rollback plan documented

---

## Common Commands Reference

```bash
# Check container status
ssh saturn.local "sudo /usr/local/bin/docker ps | grep jellyseerr"

# View logs
ssh saturn.local "sudo /usr/local/bin/docker logs jellyseerr -f"

# Check version
curl -s https://requests.discomarder.live/api/v1/status | jq '.commitTag'

# List recent images
ssh saturn.local "sudo /usr/local/bin/docker images seerr-radarr-blocklist | head -5"

# Database query
ssh saturn.local "sqlite3 /volume2/nvme2/docker/jellyseerr/config/db/db.sqlite3 'SELECT...'"

# Restart without rebuild
ssh saturn.local "cd /volume1/docker-compose/stacks/sonarr-radarr && \
  sudo /usr/local/bin/docker-compose restart jellyseerr"
```

---

## Why This Process?

1. **Traceability:** Every change tracked in Git history
2. **Reproducibility:** Can rebuild any version from Git
3. **Collaboration:** Others can review changes
4. **Safety:** Easy rollback to any previous state
5. **Auditing:** Clear record of who changed what when
6. **CI/CD Ready:** Can automate in future

**SSH file copying bypasses ALL of these benefits.**

---

## Enforcement

This workflow is **mandatory** for all deployments except documented emergencies.

Violations will be:
- Logged in incident reports
- Reviewed in post-mortems
- Used to improve automation

---

**Remember:** A few extra minutes following the proper workflow saves hours of debugging mysterious issues later.

