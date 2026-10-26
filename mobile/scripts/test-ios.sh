#!/usr/bin/env bash
# Builds the Capacitor app, runs it on an iOS Simulator against a local backend
# with demo data, and checks that the in-app self-test books a table for real.
#
# Requirements: macOS, Xcode (with an iOS Simulator runtime), Node 22+.
#   cd mobile && npm install && npm run test:ios
# Options (env vars):
#   DEVICE="iPhone 16"   simulator name (default: newest available iPhone)
#   PORT=3000            backend port
set -euo pipefail

cd "$(dirname "$0")/.."
MOBILE_DIR="$PWD"
ROOT_DIR="$(cd .. && pwd)"
BUNDLE_ID="com.pingpongcenter.booking"
PORT="${PORT:-3000}"
PASSWORD="ios-sim-test"
SHOTS="$MOBILE_DIR/shots"
WORK="$(mktemp -d)"
mkdir -p "$SHOTS"

if [[ "$(uname)" != "Darwin" ]] || ! command -v xcrun >/dev/null; then
  echo "This script needs macOS with Xcode. On Linux, run: npm run test:e2e" >&2
  exit 1
fi

step() { printf '\n\033[1m▶ %s\033[0m\n' "$*"; }

# 1. Backend with demo data (5 tables, random reservations of every type)
step "Starting backend on :$PORT with demo data"
if lsof -ti tcp:"$PORT" >/dev/null 2>&1; then
  echo "Port $PORT is already in use (another server running?). Stop it, or run with PORT=3001." >&2
  exit 1
fi
[[ -d "$ROOT_DIR/node_modules" ]] || (cd "$ROOT_DIR" && npm install)
[[ -d "$MOBILE_DIR/node_modules" ]] || npm install
export DB_PATH="$WORK/pingpong.db" ADMIN_PASSWORD="$PASSWORD" PORT
(cd "$ROOT_DIR" && node scripts/seed.js --seed 2026)
# exec: the subshell becomes node, so $SERVER_PID is the server itself and the trap really stops it
(cd "$ROOT_DIR" && exec node server.js > "$WORK/server.log" 2>&1) &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null || true; wait $SERVER_PID 2>/dev/null || true; rm -rf "$WORK"' EXIT
for _ in $(seq 1 50); do curl -sf "http://localhost:$PORT/health" >/dev/null && break; sleep 0.2; done
curl -sf "http://localhost:$PORT/health" >/dev/null || { cat "$WORK/server.log"; echo "Backend did not start" >&2; exit 1; }

# 2. Web bundle with the self-test, synced into the iOS project
step "Building app bundle (API http://localhost:$PORT, self-test on)"
API_URL="http://localhost:$PORT" SELFTEST=1 node scripts/build-web.js
npx cap sync ios

# 3. Pick and boot a simulator
step "Booting simulator"
DEVICE_ID="$(xcrun simctl list devices available -j | DEVICE="${DEVICE:-}" node -e '
  const all = Object.entries(JSON.parse(require("fs").readFileSync(0)).devices)
    .filter(([runtime]) => runtime.includes("iOS")).flatMap(([, list]) => list);
  const want = process.env.DEVICE;
  const dev = want ? all.find(d => d.name === want) : all.filter(d => d.name.startsWith("iPhone")).pop();
  if (!dev) { console.error(want ? `No simulator named "${want}"` : "No iPhone simulator installed"); process.exit(1); }
  console.log(dev.udid);
')"
xcrun simctl boot "$DEVICE_ID" 2>/dev/null || true
xcrun simctl bootstatus "$DEVICE_ID" -b >/dev/null
open -a Simulator --args -CurrentDeviceUDID "$DEVICE_ID" || true
echo "Simulator: $(xcrun simctl list devices | grep "$DEVICE_ID" | sed 's/^ *//')"

# 4. Build for the simulator (no code signing needed)
step "Building iOS app (xcodebuild)"
xcodebuild -project ios/App/App.xcodeproj -scheme App -configuration Debug \
  -sdk iphonesimulator -destination "id=$DEVICE_ID" -derivedDataPath build/DerivedData \
  CODE_SIGNING_ALLOWED=NO build -quiet
APP_PATH="build/DerivedData/Build/Products/Debug-iphonesimulator/App.app"
[[ -d "$APP_PATH" ]] || { echo "Build output not found at $APP_PATH" >&2; exit 1; }

# 5. Fresh install + launch
step "Installing and launching"
xcrun simctl uninstall "$DEVICE_ID" "$BUNDLE_ID" 2>/dev/null || true
xcrun simctl install "$DEVICE_ID" "$APP_PATH"
xcrun simctl launch "$DEVICE_ID" "$BUNDLE_ID"
sleep 4
xcrun simctl io "$DEVICE_ID" screenshot "$SHOTS/ios-1-launch.png" >/dev/null

# 6. The self-test books a table inside the app; confirm it reached the server
step "Waiting for the in-app booking"
FOUND=""
for _ in $(seq 1 45); do
  FOUND="$(PORT="$PORT" PASSWORD="$PASSWORD" node -e '
    (async () => {
      const base = `http://localhost:${process.env.PORT}/api`;
      const { today } = await (await fetch(`${base}/config`)).json();
      for (let i = 0; i < 15; i++) {
        const d = new Date(`${today}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + i);
        const date = d.toISOString().slice(0, 10);
        const day = await (await fetch(`${base}/admin/day?date=${date}`, { headers: { authorization: `Bearer ${process.env.PASSWORD}` } })).json();
        const b = day.bookings.find(x => x.name === "iOS Simulator Test");
        if (b) { console.log(`${b.code} ${b.date} ${b.start}-${b.end} ${b.table.name} ${b.typeLabel} ${b.price} ${b.source}`); return; }
      }
    })().catch(() => {});
  ')"
  [[ -n "$FOUND" ]] && break
  sleep 1
done
sleep 2
xcrun simctl io "$DEVICE_ID" screenshot "$SHOTS/ios-2-result.png" >/dev/null

if [[ -z "$FOUND" ]]; then
  echo "✗ FAIL: the app did not create a booking. See $SHOTS/ios-2-result.png (the red banner shows the reason)." >&2
  exit 1
fi
echo "✓ PASS: booked from the iOS app → $FOUND"
echo "Screenshots: $SHOTS/ios-1-launch.png, $SHOTS/ios-2-result.png"

# Rebuild the normal (no self-test) bundle so a later `cap run` isn't left in test mode
node scripts/build-web.js >/dev/null && npx cap copy ios >/dev/null
