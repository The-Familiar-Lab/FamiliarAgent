const PACKAGES = { codex: "@openai/codex", claude: "@anthropic-ai/claude-code" } as const;
/** Only fixed provider recipes cross this boundary. Authentication stays inside the native CLI. */
export function buildProviderSetup(provider: keyof typeof PACKAGES) {
  const script = [
    "set -eu",
    'prefix="$HOME/.local/share/familiaragent/providers"',
    'export PATH="$prefix/node_modules/.bin:$HOME/.local/bin:$PATH"',
    `if ! command -v ${provider} >/dev/null 2>&1; then`,
    "  command -v npm >/dev/null 2>&1 || { echo 'Node.js and npm are required to install this provider.' >&2; exit 1; }",
    `  npm install --prefix "$prefix" --no-audit --no-fund ${PACKAGES[provider]}`,
    "fi",
    provider === "codex" ? "exec codex login --device-auth" : "exec claude",
  ].join("\n");
  return { command: "/bin/sh", args: ["-c", script] };
}
