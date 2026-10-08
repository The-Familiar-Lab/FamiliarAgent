set -eu
umask 077
root="$HOME/.local/share/familiaragent"
hash="$1"
case "$hash" in *[!0-9a-f]*|'') echo 'Invalid runtime digest' >&2; exit 2;; esac
[ "${#hash}" -eq 64 ] || exit 2
lock="$root/setup.lock"
mkdir "$lock" 2>/dev/null || { echo 'Another setup is running' >&2; exit 3; }
temp="$(mktemp -d "$root/runtime/.overlay.XXXXXX")"
tools="$root/runtime/tools/node_modules/@getpaseo"
changed=0
committed=0
cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  if [ "$changed" -eq 1 ] && [ "$committed" -eq 0 ]; then
    "$root/bin/familiar" daemon stop >/dev/null 2>&1 || true
    for package in server cli; do
      if [ -d "$tools/$package/dist.upstream-backup" ]; then
        rm -rf "$tools/$package/dist"
        mv "$tools/$package/dist.upstream-backup" "$tools/$package/dist"
      fi
    done
    "$root/bin/familiar" daemon start >/dev/null 2>&1 || echo 'Previous runtime restored, but restart failed. Inspect daemon logs.' >&2
    echo 'Installation did not complete; previous runtime restored.' >&2
  fi
  rm -rf "$temp"
  rmdir "$lock"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' HUP INT TERM
cat > "$temp/runtime.tgz"
if command -v sha256sum >/dev/null; then actual="$(sha256sum "$temp/runtime.tgz" | cut -d ' ' -f 1)"; else actual="$(shasum -a 256 "$temp/runtime.tgz" | cut -d ' ' -f 1)"; fi
[ "$hash" = "$actual" ] || { echo 'Runtime bundle checksum mismatch' >&2; exit 4; }
if [ -f "$root/runtime/build.sha256" ]; then
  if [ "$(cat "$root/runtime/build.sha256")" = "$hash" ]; then echo 'FamiliarAgent runtime already current'; exit 0; fi
  "$root/bin/familiar" ls --json > "$temp/agents.json"
  node_binary="$(find "$root/runtime" -path '*/bin/node' -type f | head -1)"
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
fi
tar -xzf "$temp/runtime.tgz" -C "$temp"
for package in server cli; do
  [ -d "$temp/$package/dist" ] || { echo 'Incomplete runtime bundle' >&2; exit 4; }
  [ ! -e "$tools/$package/dist.upstream-backup" ] || { echo 'A previous recovery is pending. Inspect runtime backups before retrying.' >&2; exit 5; }
done
"$root/bin/familiar" daemon stop
changed=1
for package in server cli; do
  mv "$tools/$package/dist" "$tools/$package/dist.upstream-backup"
  mv "$temp/$package/dist" "$tools/$package/dist"
done
"$root/bin/familiar" daemon start
"$root/bin/familiar" plugin call familiar-workspace space.list '{}' --json >/dev/null
printf '%s\n' "$hash" > "$root/runtime/build.sha256"
committed=1
for package in server cli; do rm -rf "$tools/$package/dist.upstream-backup"; done
echo 'FamiliarAgent shared workspace and file streaming installed'
