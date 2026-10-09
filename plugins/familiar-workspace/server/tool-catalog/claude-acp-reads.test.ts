import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { CLAUDE_ACP_READ_BRIDGE, gooseContextReadEnvironment } from "./claude-acp-reads.js";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const descriptor = {
  name: "familiar_context",
  command: "/bin/sh",
  args: ["-c", "exec exact shared command"],
  env: [],
};
async function runBridge(params: Record<string, unknown>, selected = true) {
  const root = await mkdtemp(path.join(os.tmpdir(), "familiar-acp-' "));
  roots.push(root);
  await writeFile(path.join(root, "package.json"), '{"type":"module"}');
  await writeFile(
    path.join(root, "lib.js"),
    "export class ClaudeAcpAgent { async newSession(params) { return {...params, originalEntrypoint: true, thisPreserved: this instanceof ClaudeAcpAgent}; } }",
  );
  await writeFile(
    path.join(root, "index.js"),
    "import {ClaudeAcpAgent} from './lib.js'; console.log(JSON.stringify(await new ClaudeAcpAgent().newSession(JSON.parse(process.argv[2]))));",
  );
  await writeFile(path.join(root, "bridge.mjs"), CLAUDE_ACP_READ_BRIDGE);
  const output = execFileSync(
    process.execPath,
    [path.join(root, "bridge.mjs"), path.join(root, "index.js"), JSON.stringify(params)],
    {
      env: {
        ...process.env,
        FAMILIAR_SESSION_ID: selected ? "logical" : "",
        FAMILIAR_GOOSE_CONTEXT_DESCRIPTOR: JSON.stringify(descriptor),
      },
    },
  );
  return JSON.parse(output.toString());
}
it("adds only exact shared read tools while preserving native options, deny and ask rules", async () => {
  const options = {
    allowedTools: ["Read"],
    disallowedTools: ["mcp__familiar_context__familiar_history"],
    settings: { permissions: { ask: ["Read"] } },
    permissionMode: "acceptEdits",
    allowDangerouslySkipPermissions: false,
  };
  const output = await runBridge({
    cwd: "/chosen",
    mcpServers: [descriptor],
    _meta: { retained: "yes", claudeCode: { retained: true, options } },
  });
  expect(output.originalEntrypoint).toBe(true);
  expect(output.thisPreserved).toBe(true);
  expect(output._meta.claudeCode.options).toEqual({
    ...options,
    allowedTools: [
      "Read",
      "mcp__familiar_context__familiar_context",
      "mcp__familiar_context__familiar_history",
      "mcp__familiar_context__familiar_skill",
    ],
  });
  expect(output._meta.retained).toBe("yes");
  expect(JSON.stringify(output._meta)).not.toContain("familiar_memory");
});
it.each([
  ["other name", { ...descriptor, name: "unrelated" }],
  ["foreign executable", { ...descriptor, command: "/foreign" }],
  ["foreign arguments", { ...descriptor, args: ["-c", "foreign"] }],
  ["foreign environment", { ...descriptor, env: [{ name: "OVERRIDE", value: "foreign" }] }],
])("does not preapprove an MCP server with %s", async (_name, server) => {
  const output = await runBridge({ mcpServers: [server] });
  expect(output._meta).toBeUndefined();
});
it("does not preapprove without the selected logical session or with duplicate server names", async () => {
  expect((await runBridge({ mcpServers: [descriptor] }, false))._meta).toBeUndefined();
  expect((await runBridge({ mcpServers: [descriptor, descriptor] }))._meta).toBeUndefined();
});
it("derives a descriptor only from the exact generated shared extension shape", () => {
  expect(gooseContextReadEnvironment(["--with-extension", "unrelated:command"])).toEqual({});
  expect(
    JSON.parse(
      gooseContextReadEnvironment([
        "--with-extension",
        "familiar_context:/bin/sh -c 'exec exact shared command'",
      ]).FAMILIAR_GOOSE_CONTEXT_DESCRIPTOR!,
    ),
  ).toEqual(descriptor);
});
