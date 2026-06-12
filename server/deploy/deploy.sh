#!/usr/bin/env bash
# FastLogs deployment script.
#
# SECURITY NOTES:
#   - Rotate the deploy SSH key periodically (see INSTALL.md - SSH key rotation).
#   - NEVER commit secrets (tokens, passwords) to the repository.
#   - The deploy user has NO sudo/root privileges.
#
# Usage: ./deploy/deploy.sh user@host
# Example: ./deploy/deploy.sh fastlogs@your-domain.example

set -euo pipefail

REMOTE="${1:-fastlogs@your-domain.example}"
APP_DIR="/var/lib/fastlogs/app"
SERVER_DIR="${APP_DIR}/server"

echo "==> Deploying FastLogs to ${REMOTE}"

# 1. Sync source and public assets (exclude dev/test files and secrets).
echo "--> Syncing source files..."
rsync -az --delete \
  --exclude 'node_modules/' \
  --exclude 'data/' \
  --exclude 'blobs/' \
  --exclude '.env' \
  --exclude 'test/' \
  --exclude '*.test.js' \
  "$(dirname "$0")/../" \
  "${REMOTE}:${SERVER_DIR}/"

# 2. Install production dependencies on the server.
echo "--> Installing dependencies (npm ci --omit=dev)..."
ssh "${REMOTE}" "cd ${SERVER_DIR} && npm ci --omit=dev"

# 3. Run database migrations.
echo "--> Running migrations..."
ssh "${REMOTE}" "cd ${SERVER_DIR} && node scripts/migrate.js"

# 4. Restart the service.
echo "--> Restarting fastlogsd..."
ssh "${REMOTE}" "systemctl restart fastlogsd"

echo "==> Deploy complete. Verify the /api/health endpoint on your domain."
