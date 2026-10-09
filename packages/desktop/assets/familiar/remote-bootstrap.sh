#!/bin/sh
# User-scoped runtime only. Arguments are supplied by the validated desktop installer.
set -eu
umask 077
port="$1"
node_version="$2"
root="${FAMILIAR_INSTALL_ROOT:-$HOME/.local/share/familiaragent}"
case "$port" in ''|*[!0-9]*) echo 'Invalid server port' >&2; exit 2;; esac
case "$(uname -s)" in Linux) platform=linux;; Darwin) platform=darwin;; *) echo 'Supported servers: Linux and macOS' >&2; exit 2;; esac
case "$(uname -m)" in x86_64|amd64) arch=x64;; aarch64|arm64) arch=arm64;; *) echo 'Supported architectures: x86_64 and arm64' >&2; exit 2;; esac
command -v curl >/dev/null || { echo 'curl is required on the server' >&2; exit 2; }
command -v tar >/dev/null || { echo 'tar is required on the server' >&2; exit 2; }
node_dir="$root/runtime/node-v$node_version-$platform-$arch"
verify_existing_port() {
  "$node_dir/bin/node" - "$root" "$port" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [root, requested] = process.argv.slice(2);
const configPath = path.join(root, 'state/config.json');
const config = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : {};
const launcherPath = path.join(root, 'bin/familiar');
const launcher = fs.existsSync(launcherPath) ? fs.readFileSync(launcherPath, 'utf8') : '';
const exported = /^export PASEO_LISTEN=(?:'([^']*)'|"([^"]*)"|([^\s]+))$/m.exec(launcher);
const addresses = [config.daemon?.listen, exported && (exported[1] ?? exported[2] ?? exported[3])].filter(Boolean);
for (const address of addresses) {
  const existing = typeof address === 'string' ? /:(\d+)$/.exec(address)?.[1] : undefined;
  if (existing !== requested) {
    throw new Error(`Existing FamiliarAgent endpoint is ${String(address)}. Connect using its existing port, or stop the server and change its listen configuration and launcher explicitly before choosing port ${requested}. No active configuration was changed.`);
  }
}
NODE
}
if [ -x "$node_dir/bin/node" ]; then verify_existing_port; fi
mkdir -p "$root/runtime" "$root/state" "$root/bin"
lock="$root/setup.lock"
if ! mkdir "$lock" 2>/dev/null; then echo 'Another FamiliarAgent installation is in progress. Check setup.lock before retrying.' >&2; exit 3; fi
temp=''
cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  if [ -n "$temp" ]; then rm -rf "$temp"; fi
  rmdir "$lock"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' HUP INT TERM
temp="$(mktemp -d "$root/runtime/.setup.XXXXXX")"
if [ ! -x "$node_dir/bin/node" ]; then
  echo 'Preparing verified Node.js runtime…'
  archive="node-v$node_version-$platform-$arch.tar.gz"
  base="https://nodejs.org/dist/v$node_version"
  curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 --connect-timeout 20 --max-time 600 "$base/$archive" -o "$temp/$archive"
  curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 --connect-timeout 20 --max-time 60 "$base/SHASUMS256.txt" -o "$temp/SHASUMS256.txt"
  expected="$(awk -v name="$archive" '$2 == name {print $1}' "$temp/SHASUMS256.txt")"
  [ -n "$expected" ] || { echo 'Runtime checksum missing' >&2; exit 4; }
  if command -v sha256sum >/dev/null; then actual="$(sha256sum "$temp/$archive" | cut -d ' ' -f 1)"; else actual="$(shasum -a 256 "$temp/$archive" | cut -d ' ' -f 1)"; fi
  [ "$expected" = "$actual" ] || { echo 'Runtime checksum mismatch' >&2; exit 4; }
  tar -xzf "$temp/$archive" -C "$temp"
  mv "$temp/node-v$node_version-$platform-$arch" "$node_dir"
fi
verify_existing_port
export PATH="$root/providers/node_modules/.bin:$node_dir/bin:$root/runtime/tools/node_modules/.bin:$HOME/.local/bin:$PATH"
export PASEO_HOME="$root/state"
export PASEO_LISTEN="127.0.0.1:$port"
export PASEO_RELAY_ENABLED=false
# A dedicated launcher preserves this runtime without modifying shell startup files.
node - "$root" "$node_dir" "$port" <<'NODE'
const fs = require('node:fs');
const [root, nodeDir, port] = process.argv.slice(2);
const quote = s => "'" + s.replaceAll("'", "'\\''") + "'";
const launcher = '#!/bin/sh\nexport PATH=' + quote(root+'/providers/node_modules/.bin:'+nodeDir+'/bin:'+root+'/runtime/tools/node_modules/.bin') + ':"$HOME/.local/bin:$PATH"\nexport PASEO_HOME=' + quote(root+'/state') + '\nexport PASEO_LISTEN=' + quote('127.0.0.1:'+port) + '\nexport PASEO_CLI=' + quote(root+'/bin/familiar') + '\nexport PASEO_RELAY_ENABLED=false\nexec paseo "$@"\n';
if (!fs.existsSync(root+'/bin/familiar')) fs.writeFileSync(root+'/bin/familiar', launcher, {mode:0o700,flag:'wx'});
const configPath = root+'/state/config.json';
if (!fs.existsSync(configPath)) fs.writeFileSync(configPath, JSON.stringify({version:1, daemon:{listen:'127.0.0.1:'+port,relay:{enabled:false}},features:{dictation:{enabled:false},voiceMode:{enabled:false}}}), {flag:'wx',mode:0o600});
NODE
echo 'Verified runtime prepared; the dependency transaction will start the private workspace.'
