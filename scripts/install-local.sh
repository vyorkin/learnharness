#!/usr/bin/env bash
# install-local.sh — make the copy installed on THIS machine be the working
# tree (owner rule, 2026-10-26: the installed LearnHarness always matches the
# checkout we are working on).
#
# Two things "installed" means on a Linux dev host, and this script updates
# both:
#   1. the desktop app: ~/Applications/LearnHarness-<version>-<arch>.AppImage,
#      reached through the stable symlink ~/Applications/learnharness.AppImage
#      that ~/.local/share/applications/learnharness.desktop launches;
#   2. the systemd user service `learnharness` (http://localhost:3210), which
#      runs .next/standalone/server.js straight out of this checkout.
#
# It is the Linux counterpart of `npm run desktop:dist` (macOS signing path)
# and follows the build pipeline docs/desktop-release.md prescribes: build →
# curate the standalone payload → smoke it in Electron's own Node → package.
#
# Run it when you want the installed copy to catch up. The build replaces
# .next/standalone, so the web service is stopped first and started again at
# the end (including on failure — a stopped service helps nobody).
#
#   npm run install:local
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

APP_DIR="$HOME/Applications"
LINK="$APP_DIR/learnharness.AppImage"
SERVICE="learnharness"

log() { printf '\n==> %s\n' "$*"; }
die() { printf 'install-local: %s\n' "$*" >&2; exit 1; }

[[ "$(uname -s)" == "Linux" ]] || die "Linux only — on macOS the signed path is \`npm run desktop:dist\`."

case "$(uname -m)" in
	aarch64 | arm64) EB_ARCH=(--arm64); ART_ARCH=arm64 ;;
	x86_64 | amd64) EB_ARCH=(--x64); ART_ARCH=x64 ;;
	*) die "unsupported architecture: $(uname -m)" ;;
esac

VERSION="$(node -p "require('./package.json').version")"
ARTIFACT="dist/LearnHarness-${VERSION}-${ART_ARCH}.AppImage"

# ── 0. stop the web service (its server lives in the tree we are about to
#       replace) ────────────────────────────────────────────────────────────
SERVICE_RUNNING=0
if systemctl --user is-active --quiet "$SERVICE"; then
	log "stopping $SERVICE for the rebuild"
	systemctl --user stop "$SERVICE"
	SERVICE_RUNNING=1
fi
restore_service() {
	if (( SERVICE_RUNNING )); then
		systemctl --user start "$SERVICE" || printf 'install-local: warning: could not start %s\n' "$SERVICE" >&2
	fi
}
trap restore_service EXIT
trap 'exit 130' INT TERM

# ── 1. Next build ──────────────────────────────────────────────────────────
log "1/6 next build"
rm -rf .next/standalone
npm run build

# ── 2. curate the packaged server payload (public/, .next/static, guards) ──
log "2/6 curate the standalone server payload"
node scripts/build-server.mjs

# ── 3. smoke the payload in Electron's bundled Node (the shell's runtime) ──
#        smoke-server boots the standalone server and probes the GET-only API
#        surface; the provider smoke walks Pi's Google path offline.
log "3/6 smoke the packaged server and the provider runtime"
node scripts/smoke-provider-runtime.mjs
node scripts/smoke-server.mjs --electron

# ── 4. package the AppImage ────────────────────────────────────────────────
log "4/6 package the AppImage"
npx electron-builder --linux AppImage "${EB_ARCH[@]}" --publish never
[[ -f "$ARTIFACT" ]] || die "electron-builder did not produce $ARTIFACT"

# ── 5. install: copy, repoint the stable symlink, keep one previous build ──
log "5/6 install into $APP_DIR"
mkdir -p "$APP_DIR"
cp -f "$ARTIFACT" "$APP_DIR/"
ln -sfn "$APP_DIR/$(basename "$ARTIFACT")" "$LINK"
# Drop everything older than the new file except the newest previous one
# (each AppImage is ~190MB; the symlink is what the desktop entry launches).
while IFS= read -r old; do
	rm -f -- "$old"
done < <(
	find "$APP_DIR" -maxdepth 1 -name 'LearnHarness-*-*.AppImage' \
		! -path "$APP_DIR/$(basename "$ARTIFACT")" \
		-printf '%T@ %p\n' | sort -rn | cut -d' ' -f2- | tail -n +2
)

# ── 6. start the web service again ─────────────────────────────────────────
log "6/6 restart $SERVICE"
if (( SERVICE_RUNNING )); then
	restore_service
	trap - EXIT
else
	printf 'install-local: %s was not running — start it with `systemctl --user start %s`\n' "$SERVICE" "$SERVICE"
fi

# ── report ─────────────────────────────────────────────────────────────────
PAYLOAD_BUILD_ID="$(cat "dist/linux-${ART_ARCH}-unpacked/resources/server/standalone/.next/BUILD_ID" 2>/dev/null || echo '?')"
printf '\ninstalled: %s\n' "$APP_DIR/$(basename "$ARTIFACT")"
printf 'symlink:   %s -> %s\n' "$LINK" "$(readlink "$LINK")"
printf 'version:   %s\n' "$VERSION"
printf 'build id:  %s (.next %s)\n' "$PAYLOAD_BUILD_ID" "$(cat .next/BUILD_ID 2>/dev/null || echo '?')"
if (( SERVICE_RUNNING )); then
	printf 'service:   %s %s\n' "$SERVICE" "$(systemctl --user is-active "$SERVICE")"
fi
