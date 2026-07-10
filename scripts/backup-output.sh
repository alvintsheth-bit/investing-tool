#!/bin/bash
# Nightly backup of output/ (gitignored) to iCloud-synced Documents folder.
# Triggered by com.investing-tool.backup.plist at 2:00am PT.

INVESTING_DIR="/Users/alvintsheth/investing-tool"
BACKUP_ROOT="/Users/alvintsheth/Documents/investing-tool-backups"
DATE=$(date +%Y-%m-%d)
DEST="$BACKUP_ROOT/$DATE"

mkdir -p "$DEST"
rsync -a --delete "$INVESTING_DIR/output/" "$DEST/"

# Keep last 30 days; delete older dated directories
find "$BACKUP_ROOT" -maxdepth 1 -type d -name "20[0-9][0-9]-[0-9][0-9]-[0-9][0-9]" | sort | head -n -30 | xargs rm -rf 2>/dev/null

echo "[$(date)] backup-output: output/ → $DEST"
