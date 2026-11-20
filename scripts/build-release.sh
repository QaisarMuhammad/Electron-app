#!/bin/bash
# Builds the GadgetsPOS Desktop installers for one RELEASE CHANNEL.
#
#   scripts/build-release.sh <production|testing> [win|mac|all]
#
#   production  default address https://gadgetspos.com,            update feed https://gadgetspos.com/app-releases/desktop/
#   testing     default address https://vendor.societyfiles.com,   update feed https://vendor.societyfiles.com/app-releases/desktop/
#
# The channel is written into package.json for the duration of the build (and put back afterwards, even when the build fails): the
# installed app reads it (src/main/channel.js) and electron-builder writes the feed into resources/app-update.yml. Output: dist/<channel>/
#   Windows  Gadgets-POS-Setup-<version>.exe (+ .blockmap), latest.yml
#   Mac      Gadgets-POS-<version>-mac-universal.dmg and .zip (+ .blockmap), latest-mac.yml
# Windows installers can be built on a Mac (electron-builder runs its own Wine); Mac installers need a Mac. Nothing here signs anything:
# the owner release gate "signed Windows build" stays open until build.win.publisherName and a certificate exist (npm run release:check).
set -euo pipefail
cd "$(dirname "$0")/.."

CHANNEL="${1:-}"
TARGET="${2:-all}"
case "$CHANNEL" in
  production) HOST="https://gadgetspos.com" ;;
  testing) HOST="https://vendor.societyfiles.com" ;;
  *) echo "usage: scripts/build-release.sh <production|testing> [win|mac|all]" >&2; exit 2 ;;
esac
case "$TARGET" in win|mac|all) ;; *) echo "target must be win, mac or all" >&2; exit 2 ;; esac
FEED="$HOST/app-releases/desktop/"

cp package.json package.json.release-backup
trap 'mv -f package.json.release-backup package.json' EXIT
CHANNEL="$CHANNEL" FEED="$FEED" node -e '
  const fs = require("fs");
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  pkg.gposChannel = process.env.CHANNEL;
  pkg.build.publish = [{ provider: "generic", url: process.env.FEED }];
  fs.writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");
'

echo "== release gates (information only: the open ones are the owner's)"
npm run release:check 2>&1 | grep -E "^not ok|^ok|^# (pass|fail)" || true

OUT="dist/$CHANNEL"
rm -rf "$OUT"
ARGS=(--publish never "-c.directories.output=$OUT")
if [ "$TARGET" = "win" ] || [ "$TARGET" = "all" ]; then echo "== Windows ($CHANNEL, feed $FEED)"; npx electron-builder "${ARGS[@]}" --win --x64; fi
if [ "$TARGET" = "mac" ] || [ "$TARGET" = "all" ]; then echo "== Mac ($CHANNEL, feed $FEED)"; npx electron-builder "${ARGS[@]}" --mac; fi
echo "== done: $OUT"
ls -la "$OUT" | grep -E "\.(exe|dmg|zip|yml|blockmap)$" || true
