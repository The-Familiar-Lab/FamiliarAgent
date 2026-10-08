import { afterEach, expect, test, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile, appendFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createDaemonTestContext, type DaemonTestContext } from "../test-utils/index.js";
import { BuiltinPluginLoader } from "../plugins/builtin/index.js";
import {
  compositionContext,
  compositionRuntime,
  compositionSession,
} from "../../../../../plugins/familiar-workspace/shared/composition.js";

let context: DaemonTestContext | undefined;
let root: string | undefined;
let mcp: Client | undefined;
afterEach(async () => {
  await mcp?.close();
  await context?.cleanup();
  if (root) await rm(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

test("real daemon composes pointer forks and serves shared context through MCP stdio", async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "familiar-composition-rpc-"));
  const home = path.join(root, ".paseo");
  const productRoot = path.resolve(import.meta.dirname, "../../../../..");
  const cli = path.join(productRoot, "packages/cli/dist/index.js");
  const launcher = path.join(root, "familiar");
  const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  await writeFile(
    launcher,
    `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(cli)} "$@"\n`,
    { mode: 0o700 },
  );
  vi.stubEnv("PASEO_HOME", home);
  vi.stubEnv("PASEO_CLI", launcher);
  const nativeHome = path.join(root, "codex-fixture");
  vi.stubEnv("CODEX_HOME", nativeHome);
  context = await createDaemonTestContext({
    paseoHomeRoot: root,
    daemonVersion: "0.11.1",
    pluginsEnabled: true,
    builtinPlugins: new BuiltinPluginLoader(path.join(productRoot, "plugins"), [
      "familiar-workspace",
    ]),
  });
  const rpc = (method: string, input: unknown) =>
    context!.client.invokePluginRpc("familiar-workspace", method, input);
  const serverId = (await readFile(path.join(home, "server-id"), "utf8")).trim();
  await rpc("composition.project.save", {
    operationId: "project",
    id: "integration",
    title: "Integration",
    expectedRevision: 0,
    memory: "SHARED_CONTEXT_MARKER",
    resources: [],
  });
  const agent = await context.client.createAgent({
    provider: "codex",
    cwd: root,
    initialPrompt: `HISTORY_BEFORE_FORK ${"x".repeat(120000)}`,
    clientMessageId: "large-prompt",
    title: "Native source",
  });
  await expect
    .poll(async () => (await context!.client.fetchAgent(agent.id))?.agent.status)
    .toBe("idle");
  const nativeId = (await context.client.fetchAgent(agent.id))?.agent.persistence?.sessionId;
  expect(nativeId).toBeTruthy();
  await mkdir(path.join(nativeHome, "sessions"), { recursive: true });
  const nativeFile = path.join(nativeHome, "sessions", `${nativeId}.jsonl`);
  const nativeMessage = (text: string) => ({
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text }],
    },
  });
  // Fake provider persists this native-source fixture; product code still reads only original bytes.
  await writeFile(
    nativeFile,
    [
      { type: "session_meta", payload: { id: nativeId } },
      nativeMessage(`HISTORY_BEFORE_FORK ${"x".repeat(120000)}`),
    ]
      .map((item) => JSON.stringify(item))
      .join("\n") + "\n",
  );
  const first = compositionSession.parse(
    await rpc("composition.create", {
      operationId: "create",
      projectId: "integration",
      title: "A",
      endpoint: { serverId, agentId: agent.id, provider: "codex", cwd: root },
    }),
  );
  const nativeBefore = await context.client.fetchAgentTimeline(agent.id, {
    limit: 100,
    projection: "canonical",
  });
  const historyBytes = Buffer.byteLength(JSON.stringify(nativeBefore.entries));
  expect(historyBytes).toBeGreaterThan(100000);
  const databaseSizes = async () => {
    const files = ["composition.sqlite", "composition.sqlite-wal", "composition.sqlite-shm"];
    const sizes = await Promise.all(
      files.map(async (file) => {
        try {
          return (await stat(path.join(home, "familiar/composition", file))).size;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
          throw error;
        }
      }),
    );
    return {
      main: sizes[0],
      wal: sizes[1],
      sharedMemory: sizes[2],
      total: sizes.reduce((sum, size) => sum + size, 0),
    };
  };
  const storageBeforeFork = await databaseSizes();
  const fork = compositionSession.parse(
    await rpc("composition.fork", {
      operationId: "fork",
      id: first.id,
      expectedRevision: 1,
      title: "B",
    }),
  );
  expect(fork.resources).toEqual([]);
  expect(fork.parent?.sessionId).toBe(first.id);
  const forkBytes = Buffer.byteLength(JSON.stringify(fork));
  const storageAfterFork = await databaseSizes();
  expect(forkBytes).toBeLessThan(2048);
  expect(fork.parent?.historyBoundaries[first.resources[0].id].kind).toBe("native");
  await context.client.sendMessage(agent.id, "HISTORY_AFTER_FORK", {
    messageId: "later",
    activeTurnBehavior: "steer",
  });
  await expect
    .poll(async () => (await context!.client.fetchAgent(agent.id))?.agent.status)
    .toBe("idle");
  await appendFile(nativeFile, JSON.stringify(nativeMessage("HISTORY_AFTER_FORK")) + "\n");
  const runtime = compositionRuntime.output.parse(
    await rpc("composition.runtime", { sessionId: fork.id }),
  );
  expect(runtime.mcpServers.familiar_context.command).toBe(launcher);
  mcp = new Client({ name: "familiar-composition-verifier", version: "1" });
  await mcp.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [
        cli,
        "context",
        "mcp",
        "--host",
        `127.0.0.1:${context.daemon.port}`,
        "--session",
        fork.id,
      ],
      stderr: "pipe",
    }),
  );
  const tools = await mcp.listTools();
  expect(tools.tools.map((item) => item.name)).toContain("familiar_history");
  const parsed = (result: Awaited<ReturnType<Client["callTool"]>>) => {
    expect(result.isError).not.toBe(true);
    const content = result.content as { type: string; text: string }[];
    return JSON.parse(content[0].text);
  };
  const shared = compositionContext.parse(
    parsed(await mcp.callTool({ name: "familiar_context", arguments: {} })),
  );
  expect(shared.memories.some((item) => item.text.includes("SHARED_CONTEXT_MARKER"))).toBe(true);
  const read = parsed(
    await mcp.callTool({
      name: "familiar_history",
      arguments: { resourceId: first.resources[0].id, maxCharacters: 256, limit: 10 },
    }),
  );
  expect(JSON.stringify(read.messages)).toContain("HISTORY_BEFORE_FORK");
  expect(JSON.stringify(read.messages)).not.toContain("HISTORY_AFTER_FORK");
  expect(
    read.messages.map((item: { text: string }) => item.text).join("").length,
  ).toBeLessThanOrEqual(256);
  const updated = compositionSession.parse(
    parsed(
      await mcp.callTool({
        name: "familiar_memory",
        arguments: { expectedRevision: 1, memory: "MCP_MEMORY_ROUND_TRIP" },
      }),
    ),
  );
  expect(updated.id).toBe(fork.id);
  expect(updated.revision).toBe(2);
  const latest = compositionSession.parse(await rpc("composition.read", { id: fork.id }));
  expect(latest.memory).toBe("MCP_MEMORY_ROUND_TRIP");
  const report = {
    testedAt: new Date().toISOString(),
    isolatedRealDaemon: true,
    realMcpStdio: true,
    provider: "test provider, no model calls",
    historyBytes,
    forkManifestBytes: forkBytes,
    runtime: process.version,
    databaseBytes: await databaseSizes(),
    forkPersistenceGrowthBytes: storageAfterFork.total - storageBeforeFork.total,
    historyCopiedIntoFork: false,
    pinnedHistoryExcludesLaterMessages: true,
    mcpReadWritePassed: true,
  };
  const reportDirectory = path.resolve(productRoot, "../work");
  await mkdir(reportDirectory, { recursive: true });
  await writeFile(
    path.join(reportDirectory, "composition-backend-verification.json"),
    JSON.stringify(report, null, 2),
  );
}, 45000);
