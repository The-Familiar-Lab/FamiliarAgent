import path from "node:path";
import { rm } from "node:fs/promises";
import { z } from "zod";
import { readJson, writeText } from "./files.js";
import type { ToolCatalog } from "./service.js";
import type { ToolPlan } from "../../shared/tool-catalog.js";
import { CLAUDE_ACP_READ_BRIDGE } from "./claude-acp-reads.js";

export const GOOSE_ACP = {
  codex: {
    provider: "codex-acp",
    command: "codex-acp",
    package: "@agentclientprotocol/codex-acp@2.1.1",
    label: "Codex",
  },
  claude: {
    provider: "claude-acp",
    command: "claude-agent-acp",
    package: "@agentclientprotocol/claude-agent-acp@0.88.0",
    label: "Claude Code",
  },
} as const;
const preferences = z
  .object({
    provider: z.enum(["codex-acp", "claude-acp"]),
    model: z.literal("current"),
    mode: z.literal("smart_approve"),
  })
  .strict();
export function goosePreferencesFile(root: string): string {
  return path.join(root, "familiar", "goose-provider.json");
}
export async function readGooseProvider(root: string) {
  const value = await readJson(goosePreferencesFile(root));
  return value === undefined ? undefined : preferences.parse(value);
}
export async function resetGooseProvider(root: string): Promise<void> {
  await rm(goosePreferencesFile(root), { force: true });
}
export async function gooseProviderEnvironment(root: string): Promise<Record<string, string>> {
  const selected = await readGooseProvider(root);
  if (!selected) return {};
  return {
    GOOSE_PROVIDER: selected.provider,
    GOOSE_MODEL: selected.model,
    GOOSE_MODE: selected.mode,
    GOOSE_SEARCH_PATHS: JSON.stringify(gooseAdapterBins(root)),
  };
}
export function gooseAdapterBins(root: string): string[] {
  return Object.keys(GOOSE_ACP).flatMap((id) => [
    path.join(root, "tools", "goose-acp", id, "bin"),
    path.join(root, "tools", "goose-acp", id, "node_modules", ".bin"),
  ]);
}

/** Installation owns no credentials. Selection commits only after the original adapter installs. */
export const GOOSE_ACP_INSTALLER = `import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, accessSync, constants } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
const [npm, prefix, spec, executable, file, provider, bridgeSourceFile] = process.argv.slice(2);
if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Node.js 22 or newer is required');
const result = spawnSync(npm, ['install', '--prefix', prefix, '--no-audit', '--no-fund', spec], { stdio: 'inherit', env: { ...process.env, COREPACK_ENABLE_AUTO_PIN: '0' } });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
accessSync(executable, constants.X_OK);
if (provider === 'claude-acp') {
  const wrapper = join(prefix, 'familiar-context-reads.mjs');
  const entry = join(prefix, 'node_modules', '@agentclientprotocol', 'claude-agent-acp', 'dist', 'index.js');
  const bin = join(prefix, 'bin');
  const quote = value => "'" + value.replaceAll("'", "'\\\\''") + "'";
  mkdirSync(bin, { recursive: true, mode: 0o700 });
  writeFileSync(wrapper, readFileSync(bridgeSourceFile, 'utf8'), { mode: 0o600 });
  writeFileSync(join(bin, 'claude-agent-acp'), '#!/bin/sh\\nexec ' + [process.execPath, wrapper, entry].map(quote).join(' ') + ' "$@"\\n', { mode: 0o700 });
}
mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
const temporary = file + '.' + randomUUID() + '.tmp';
try {
  writeFileSync(temporary, JSON.stringify({ provider, model: 'current', mode: 'smart_approve' }) + '\\n', { mode: 0o600, flag: 'wx' });
  renameSync(temporary, file);
} finally { rmSync(temporary, { force: true }); }
console.log('Goose will use the original native account on this server. Return to FamiliarAgent and choose Check setup to check sign-in. No API URL or new API key is needed.');
`;

export async function prepareGooseProvider(
  root: string,
  cwd: string,
  tools: ToolCatalog,
  account: keyof typeof GOOSE_ACP,
): Promise<ToolPlan> {
  await tools.resolveCommand(account);
  const recipe = GOOSE_ACP[account];
  const prefix = path.join(root, "tools", "goose-acp", account);
  const script = path.join(cwd, "goose-acp-install.mjs");
  await writeText(script, GOOSE_ACP_INSTALLER);
  const bridge = path.join(cwd, "claude-acp-reads.mjs");
  await writeText(bridge, CLAUDE_ACP_READ_BRIDGE);
  return {
    toolId: "goose",
    action: "launch",
    mode: "terminal",
    cwd,
    command: "/usr/bin/env",
    args: [
      `PATH=${tools.searchPath()}`,
      await tools.resolveCommand("node"),
      script,
      await tools.resolveCommand("npm"),
      prefix,
      recipe.package,
      path.join(prefix, "node_modules", ".bin", recipe.command),
      goosePreferencesFile(root),
      recipe.provider,
      bridge,
    ],
    notes: [
      `Installs the original ${recipe.label} ACP adapter privately, then selects it only for Goose launches from FamiliarAgent. Existing native sign-in stays on this server.`,
      "The current native model and smart_approve permissions are used. The original Goose profile is unchanged.",
      "Continuing an ACP-backed conversation retains the FamiliarAgent session and shared references, but starts a fresh original agent runtime with bounded previous context; it is not a private checkpoint restore.",
    ],
  };
}
