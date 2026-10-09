#!/bin/sh
set -eu
umask 077
root="${FAMILIAR_INSTALL_ROOT:-$HOME/.local/share/familiaragent}"
hash="$1"
case "$hash" in *[!0-9a-f]*|'') echo 'Invalid runtime digest' >&2; exit 2;; esac
[ "${#hash}" -eq 64 ] || exit 2
lock="$root/setup.lock"
mkdir "$lock" 2>/dev/null || { echo 'Another setup is running' >&2; exit 3; }
temp=''
tools="$root/runtime/tools"
backup="$root/runtime/tools.rollback"
changed=0
stopped=0
committed=0
had_tools=0
backup_owned=0
[ ! -d "$tools" ] || had_tools=1
cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  if [ "$committed" -eq 0 ]; then
    if { [ "$backup_owned" -eq 1 ] && [ -d "$backup" ]; } || { [ "$had_tools" -eq 0 ] && [ "$changed" -eq 1 ]; }; then
      "$root/bin/familiar" daemon stop >/dev/null 2>&1 || true
      rm -rf "$tools"
      if [ -d "$backup" ]; then mv "$backup" "$tools"; fi
      if [ -f "$temp/previous.sha256" ]; then
        cp "$temp/previous.sha256" "$root/runtime/build.sha256"
      else
        rm -f "$root/runtime/build.sha256"
      fi
      echo 'Installation did not complete; previous runtime restored.' >&2
    fi
    if [ "$stopped" -eq 1 ] && [ "$had_tools" -eq 1 ]; then
      "$root/bin/familiar" daemon start >/dev/null 2>&1 || echo 'Previous runtime restored, but restart failed. Inspect daemon logs.' >&2
    fi
  else
    rm -rf "$backup"
  fi
  if [ -n "$temp" ]; then rm -rf "$temp"; fi
  rmdir "$lock"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' HUP INT TERM
temp="$(mktemp -d "$root/runtime/.install.XXXXXX")"
temp="$(cd "$temp" && pwd -P)"
[ ! -f "$root/runtime/build.sha256" ] || cp "$root/runtime/build.sha256" "$temp/previous.sha256"
require_idle() {
  [ "$had_tools" -eq 1 ] || return 0
  "$root/bin/familiar" ls --json > "$temp/agents.json"
  update_status=0
  "$node_binary" - "$temp/agents.json" <<'NODE' || update_status=$?
const fs = require('node:fs');
const agents = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (!Array.isArray(agents)) process.exit(5);
const resumable = new Set(['idle', 'closed', 'error']);
if (agents.some(agent => !agent || !resumable.has(agent.status))) {
  console.log('FAMILIAR_UPDATE_DEFERRED: An agent is still working or starting. Its runtime will be updated when work is idle.');
  process.exit(10);
}
NODE
  if [ "$update_status" -eq 10 ]; then exit 0; fi
  [ "$update_status" -eq 0 ] || exit "$update_status"
}
cat > "$temp/runtime.tgz"
if command -v sha256sum >/dev/null; then actual="$(sha256sum "$temp/runtime.tgz" | cut -d ' ' -f 1)"; else actual="$(shasum -a 256 "$temp/runtime.tgz" | cut -d ' ' -f 1)"; fi
[ "$hash" = "$actual" ] || { echo 'Runtime bundle checksum mismatch' >&2; exit 4; }
if [ -f "$root/runtime/build.sha256" ] && [ "$(cat "$root/runtime/build.sha256")" = "$hash" ]; then
  echo 'FamiliarAgent runtime already current'
  exit 0
fi
[ ! -e "$backup" ] || { echo 'A previous runtime recovery is pending. Inspect tools.rollback before retrying.' >&2; exit 5; }
backup_owned=1
node_binary="$(find "$root/runtime" -path '*/bin/node' -type f | head -1)"
[ -x "$node_binary" ] || { echo 'Verified Node.js runtime is missing' >&2; exit 5; }
node_bin="$(dirname "$node_binary")"
export PATH="$node_bin:$PATH"
require_idle
candidate="$temp/tools"
mkdir "$candidate"
tar -tzf "$temp/runtime.tgz" > "$temp/entries.txt"
"$node_binary" - "$temp/entries.txt" <<'NODE'
const fs = require('node:fs');
const entries = fs.readFileSync(process.argv[2], 'utf8').trim().split('\n');
if (!entries.every(entry => /^(package\.json|package-lock\.json|workspace-packages\/?|workspace-packages\/[a-zA-Z0-9_.-]+\.tgz)$/.test(entry))) {
  throw new Error('Runtime bundle contains unexpected paths');
}
NODE
tar -xzf "$temp/runtime.tgz" -C "$candidate"
"$node_binary" - "$candidate" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const root = process.argv[2];
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
if (manifest.familiarRuntime?.schemaVersion !== 1 || !manifest.dependencies?.['@getpaseo/cli'] || !manifest.dependencies?.['@getpaseo/server']) {
  throw new Error('Runtime bundle requires its current workspace package manifests and dependency lock');
}
for (const [name, source] of Object.entries(manifest.dependencies)) {
  const entry = lock.packages?.['node_modules/' + name];
  if (!/^file:workspace-packages\/[a-zA-Z0-9_.-]+\.tgz$/.test(source) || entry?.resolved !== source || !entry.integrity) {
    throw new Error('Runtime dependency is not locked to its bundled workspace: ' + name);
  }
}
NODE
echo 'Preparing locked runtime dependencies while the current server keeps running…'
"$node_bin/npm" ci --prefix "$candidate" --workspaces=false --omit=dev --no-audit --no-fund --fetch-retries=1 --fetch-timeout=60000 > "$temp/npm.log" 2>&1 || { tail -30 "$temp/npm.log" >&2; exit 5; }
[ -d "$candidate/node_modules/@getpaseo/server/dist" ] && [ -d "$candidate/node_modules/@getpaseo/cli/dist" ] || { echo 'Installed runtime is incomplete' >&2; exit 5; }
"$candidate/node_modules/.bin/paseo" --version >/dev/null
# Installation can take time; work that started meanwhile must not be interrupted.
require_idle
if [ "$had_tools" -eq 1 ]; then
  stopped=1
  "$root/bin/familiar" daemon stop
  mv "$tools" "$backup"
fi
changed=1
mv "$candidate" "$tools"
"$root/bin/familiar" daemon start
"$root/bin/familiar" plugin call familiar-workspace space.list '{}' --json >/dev/null
printf '%s\n' "$hash" > "$temp/build.sha256"
mv "$temp/build.sha256" "$root/runtime/build.sha256"
committed=1
echo 'FamiliarAgent runtime and locked dependencies installed'
