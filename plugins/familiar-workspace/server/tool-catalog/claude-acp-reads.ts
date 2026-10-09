/** A per-process decorator over the original public ACP library. The original entrypoint
 * retains managed policy, authentication, transport, approvals and shutdown handling. */
export function gooseContextReadEnvironment(args: string[]): Record<string, string> {
  const prefix = "familiar_context:/bin/sh -c '";
  const index = args.indexOf("--with-extension");
  const value = args[index + 1];
  if (index < 0 || !value?.startsWith(prefix) || !value.endsWith("'")) return {};
  return {
    FAMILIAR_GOOSE_CONTEXT_DESCRIPTOR: JSON.stringify({
      name: "familiar_context",
      command: "/bin/sh",
      args: ["-c", value.slice(prefix.length, -1)],
      env: [],
    }),
  };
}

export const CLAUDE_ACP_READ_BRIDGE = `import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
const entry = process.argv[2];
process.argv.splice(1, 2, entry);
const { ClaudeAcpAgent } = await import(pathToFileURL(join(dirname(entry), 'lib.js')).href);
const original = ClaudeAcpAgent.prototype.newSession;
if (typeof original !== 'function') throw new Error('Unsupported Claude ACP library. Run Goose setup again.');
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const expected = process.env.FAMILIAR_GOOSE_CONTEXT_DESCRIPTOR ? JSON.parse(process.env.FAMILIAR_GOOSE_CONTEXT_DESCRIPTOR) : null;
const matches = server => expected && server.name === expected.name && server.command === expected.command &&
  JSON.stringify(server.args) === JSON.stringify(expected.args) && JSON.stringify(server.env ?? []) === JSON.stringify(expected.env);
ClaudeAcpAgent.prototype.newSession = function(params) {
  const shared = process.env.FAMILIAR_SESSION_ID && Array.isArray(params.mcpServers) &&
    params.mcpServers.filter(server => server.name === 'familiar_context').length === 1 && params.mcpServers.some(matches);
  if (!shared) return original.call(this, params);
  const meta = params._meta ?? {};
  const claudeCode = meta.claudeCode ?? {};
  const options = claudeCode.options ?? {};
  if (!record(meta) || !record(claudeCode) || !record(options) ||
      (options.allowedTools !== undefined && !Array.isArray(options.allowedTools)))
    throw new Error('Unsupported existing Claude ACP session settings.');
  const allowedTools = [...new Set([...(options.allowedTools ?? []),
    'mcp__familiar_context__familiar_context', 'mcp__familiar_context__familiar_history',
    'mcp__familiar_context__familiar_skill'])];
  return original.call(this, { ...params, _meta: { ...meta, claudeCode: { ...claudeCode,
    options: { ...options, allowedTools } } } });
};
await import(pathToFileURL(entry).href);
`;
