#!/bin/bash
# Nightly backup of output/ (gitignored) to iCloud Drive.
# Triggered by com.investing-tool.backup.plist at 2:00am PT.
# Creates a dated tar.gz; 90-day retention. C1-C3 evidence base lives here.

REPO="/Users/alvintsheth/investing-tool"
DEST="/Users/alvintsheth/Library/Mobile Documents/com~apple~CloudDocs/investing-tool-backups"
DATE=$(TZ="America/Los_Angeles" date +"%Y-%m-%d")
ARCHIVE="${DEST}/output-${DATE}.tar.gz"
LOG="${REPO}/output/logs/backup.log"

mkdir -p "${DEST}"

JSON_COUNT=$(find "${REPO}/output" -maxdepth 1 -name "*.json" | wc -l | tr -d ' ')

if [ "$JSON_COUNT" -eq 0 ]; then
  echo "[backup] ${DATE}: no JSON files in output/ — skipping" >> "${LOG}"
  exit 0
fi

tar -czf "${ARCHIVE}" -C "${REPO}/output" $(find "${REPO}/output" -maxdepth 1 -name "*.json" -exec basename {} \;) 2>>"${LOG}"

if [ $? -eq 0 ]; then
  SIZE=$(du -sh "${ARCHIVE}" | cut -f1)
  echo "[backup] ${DATE}: ${JSON_COUNT} JSON files → output-${DATE}.tar.gz (${SIZE})" >> "${LOG}"
else
  echo "[backup] ${DATE}: ERROR — tar failed" >> "${LOG}"
  exit 1
fi

# Prune archives older than 90 days
find "${DEST}" -name "output-*.tar.gz" -mtime +90 -delete
