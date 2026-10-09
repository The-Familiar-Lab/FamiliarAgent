import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { createDaemonTestContext, type DaemonTestContext } from "../test-utils/index.js";
import { BuiltinPluginLoader } from "../plugins/builtin/index.js";
import {
  compositionSession,
  readCompositionSource,
} from "../../../../../plugins/familiar-workspace/shared/composition.js";
import {
  captureToolRunResult,
  compositionInputRecord,
  prepareCompositionInput,
} from "../../../../../plugins/familiar-workspace/shared/results.js";
import { toolRun } from "../../../../../plugins/familiar-workspace/shared/tool-actions.js";
import {
  startReadOnlyBridge,
  validateBridgeResources,
} from "../../../../../plugins/familiar-workspace/server/composition/bridge.js";
import type { ResourceReader } from "../../../../../plugins/familiar-workspace/server/composition/store.js";

const contexts: DaemonTestContext[] = [];
let root: string | undefined;
let bridge: Server | undefined;
afterEach(async () => {
  if (bridge) {
    bridge.closeAllConnections();
    await new Promise<void>((resolve) => bridge!.close(() => resolve()));
  }
  for (const context of contexts.splice(0).toReversed()) await context.cleanup();
  if (root) await rm(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

test("two real daemons read and compose a scoped original tool result without copying its store", async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "familiar-tool-result-bridge-"));
  const pluginRoot = path.resolve(import.meta.dirname, "../../../../../plugins");
  vi.stubEnv("PASEO_CLI", process.execPath);
  const create = async (name: string) => {
    const directory = path.join(root!, name);
    const home = path.join(directory, ".paseo");
    vi.stubEnv("PASEO_HOME", home);
    const context = await createDaemonTestContext({
      paseoHomeRoot: directory,
      pluginsEnabled: true,
      builtinPlugins: new BuiltinPluginLoader(pluginRoot, ["familiar-workspace"]),
    });
    contexts.push(context);
    return {
      context,
      home,
      serverId: (await readFile(path.join(home, "server-id"), "utf8")).trim(),
    };
  };
  const source = await create("source");
  const target = await create("target");
  const rpc = (context: DaemonTestContext, method: string, input: unknown) =>
    context.client.invokePluginRpc("familiar-workspace", method, input);
  const owner = (method: string, input: unknown) => rpc(source.context, method, input);
  const receiver = (method: string, input: unknown) => rpc(target.context, method, input);
  const selected = path.join(root, "skill-package");
  await mkdir(path.join(selected, ".claude-plugin"), { recursive: true });
  await mkdir(path.join(selected, "skills", "owned-skill"), {
    recursive: true,
  });
  await writeFile(
    path.join(selected, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "owned-native-skill", version: "1.0.0" }),
  );
  await owner("composition.project.save", {
    id: "project",
    title: "Tools",
    memory: "",
    resources: [],
    expectedRevision: 0,
    operationId: "project",
  });
  let session = compositionSession.parse(
    await owner("composition.create", {
      projectId: "project",
      title: "A",
      operationId: "create",
      endpoint: {
        serverId: source.serverId,
        kind: "tool",
        agentId: "source-tool",
        provider: "agents",
        cwd: root,
      },
    }),
  );
  await owner("tools.run.start", {
    operationId: "source-inspect",
    sessionId: session.id,
    toolId: "agents",
    action: "inspect",
    cwd: root,
    input: "",
    parameters: { pluginPath: selected },
  });
  await vi.waitFor(
    async () => {
      const run = toolRun.parse(await owner("tools.run.read", { id: "source-inspect" }));
      expect(run.error).toBeNull();
      expect(run.state).toBe("completed");
    },
    { timeout: 8000 },
  );
  const captured = captureToolRunResult.output.parse(
    await owner("tools.run.capture", { id: "source-inspect" }),
  );
  session = compositionSession.parse(
    await owner("composition.update", {
      id: session.id,
      expectedRevision: session.revision,
      operationId: "link-result",
      title: session.title,
      memory: session.memory,
      resources: [captured.anchor.resource],
    }),
  );
  const agent = await target.context.client.createAgent({
    provider: "claude",
    cwd: root,
    title: "Target",
  });
  session = compositionSession.parse(
    await owner("composition.bind", {
      id: session.id,
      expectedRevision: session.revision,
      operationId: "link-target",
      endpoint: {
        serverId: target.serverId,
        provider: "claude",
        agentId: agent.id,
        cwd: root,
      },
    }),
  );
  const reader: ResourceReader = async (resource, input) => {
    const response = readCompositionSource.output.parse(
      await owner("composition.source.read", { resource, ...input }),
    );
    return {
      messages: response.messages,
      nextOffset: response.nextOffset,
      truncated: response.truncated,
      boundary: response.resource.boundary,
    };
  };
  await validateBridgeResources([captured.anchor.resource], reader);
  const token = randomBytes(32).toString("hex");
  // Real scoped HTTP + both public daemon RPC surfaces; SSH only carries these bytes in production.
  const active = await startReadOnlyBridge({
    token,
    reader,
    targetServerId: target.serverId,
    catalog: owner,
    sessions: new Map([[session.id, undefined]]),
    resources: new Set([`${source.serverId}\0tool-result\0source-inspect`]),
  });
  bridge = active.server;
  await receiver("composition.bridge.install", {
    sourceServerId: source.serverId,
    targetServerId: target.serverId,
    port: active.port,
    token,
    sessions: [session.id],
    resourceServerIds: [source.serverId],
  });
  const read = readCompositionSource.output.parse(
    await receiver("composition.resource.read", {
      id: session.id,
      resourceId: captured.anchor.resource.id,
      maxCharacters: 65536,
    }),
  );
  expect(read.messages).toEqual([{ role: "assistant", text: captured.text }]);
  await expect(
    receiver("composition.source.read", {
      resource: { ...captured.anchor.resource, locator: "ungranted-run" },
    }),
  ).rejects.toThrow("403");
  await expect(
    receiver("composition.source.read", {
      resource: {
        ...captured.anchor.resource,
        boundary: {
          ...captured.anchor.resource.boundary,
          sha256: "0".repeat(64),
        },
      },
    }),
  ).rejects.toThrow("no longer matches");
  const prepared = prepareCompositionInput.output.parse(
    await owner("composition.input.prepare", {
      id: session.id,
      expectedRevision: session.revision,
      operationId: "tool-to-native",
      sourceEndpointId: session.endpoints[0]!.id,
      targetEndpointId: session.endpoints[1]!.id,
      anchor: captured.anchor,
      instruction: "Summarize this selected result.",
    }),
  );
  const send = () =>
    receiver("composition.input.send", {
      id: session.id,
      inputId: prepared.input.id,
    });
  expect(compositionInputRecord.parse(await send()).input.state).toBe("accepted");
  expect(compositionInputRecord.parse(await send()).input.id).toBe(prepared.input.id);
  await target.context.client.waitForFinish(agent.id, 5000);
  const timeline = await target.context.client.fetchAgentTimeline(agent.id, {
    projection: "canonical",
    direction: "tail",
    limit: 100,
  });
  const inputs = timeline.entries.flatMap((row) =>
    row.item.type === "user_message" ? [row.item.text] : [],
  );
  expect(inputs).toHaveLength(1);
  expect(inputs[0]).toBe(prepared.text);
  expect(JSON.parse(inputs[0]!.slice(inputs[0]!.indexOf("\n") + 1)).selectedResult).toBe(
    captured.text,
  );
  expect(inputs[0]).toContain("Summarize this selected result.");
  expect(await receiver("tools.runs.list", { sessionId: session.id })).toMatchObject({
    total: 0,
    runs: [],
  });
  expect(await owner("tools.run.capture", { id: "source-inspect" })).toEqual(captured);
}, 30000);
