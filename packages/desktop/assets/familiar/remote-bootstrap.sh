#!/bin/sh
# User-scoped runtime only. Arguments are supplied by the validated desktop installer.
set -eu
umask 077
port="$1"
node_version="$2"
daemon_version="$3"
root="$HOME/.local/share/familiaragent"
case "$port" in ''|*[!0-9]*) echo 'Invalid server port' >&2; exit 2;; esac
case "$(uname -s)" in Linux) platform=linux;; Darwin) platform=darwin;; *) echo 'Supported servers: Linux and macOS' >&2; exit 2;; esac
case "$(uname -m)" in x86_64|amd64) arch=x64;; aarch64|arm64) arch=arm64;; *) echo 'Supported architectures: x86_64 and arm64' >&2; exit 2;; esac
command -v curl >/dev/null || { echo 'curl is required on the server' >&2; exit 2; }
command -v tar >/dev/null || { echo 'tar is required on the server' >&2; exit 2; }
mkdir -p "$root/runtime" "$root/state" "$root/bin"
lock="$root/setup.lock"
if ! mkdir "$lock" 2>/dev/null; then echo 'Another FamiliarAgent installation is in progress. Check setup.lock before retrying.' >&2; exit 3; fi
temp="$(mktemp -d "$root/runtime/.setup.XXXXXX")"
trap 'rm -rf "$temp"; rmdir "$lock"' EXIT HUP INT TERM
node_dir="$root/runtime/node-v$node_version-$platform-$arch"
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
export PATH="$root/providers/node_modules/.bin:$node_dir/bin:$root/runtime/tools/node_modules/.bin:$HOME/.local/bin:$PATH"
export PASEO_HOME="$root/state"
export PASEO_LISTEN="127.0.0.1:$port"
export PASEO_RELAY_ENABLED=false
current="$(node -e 'try {console.log(require(process.argv[1]).version)} catch {}' "$root/runtime/tools/node_modules/@getpaseo/cli/package.json")"
if [ "$current" != "$daemon_version" ]; then
  echo 'Installing agent workspace runtime…'
  npm install --prefix "$root/runtime/tools" --no-audit --no-fund "@getpaseo/cli@$daemon_version" > "$temp/npm.log" 2>&1 || { tail -30 "$temp/npm.log" >&2; exit 5; }
fi
# A dedicated launcher preserves this runtime without modifying shell startup files.
node - "$root" "$node_dir" "$port" <<'NODE'
const fs = require('node:fs');
const [root, nodeDir, port] = process.argv.slice(2);
const quote = s => "'" + s.replaceAll("'", "'\\''") + "'";
const launcher = '#!/bin/sh\nexport PATH=' + quote(root+'/providers/node_modules/.bin:'+nodeDir+'/bin:'+root+'/runtime/tools/node_modules/.bin') + ':"$HOME/.local/bin:$PATH"\nexport PASEO_HOME=' + quote(root+'/state') + '\nexport PASEO_LISTEN=' + quote('127.0.0.1:'+port) + '\nexport PASEO_CLI=' + quote(root+'/bin/familiar') + '\nexport PASEO_RELAY_ENABLED=false\nexec paseo "$@"\n';
fs.writeFileSync(root+'/bin/familiar', launcher, {mode:0o700});
const configPath = root+'/state/config.json';
if (!fs.existsSync(configPath)) fs.writeFileSync(configPath, JSON.stringify({version:1, daemon:{listen:'127.0.0.1:'+port,relay:{enabled:false}},features:{dictation:{enabled:false},voiceMode:{enabled:false}}}), {flag:'wx',mode:0o600});
NODE
echo 'Starting private remote workspace…'
"$root/bin/familiar" daemon config set daemon.listen "127.0.0.1:$port" --string
"$root/bin/familiar" daemon config set daemon.relay.enabled false
"$root/bin/familiar" daemon start
"$root/bin/familiar" daemon status --json
