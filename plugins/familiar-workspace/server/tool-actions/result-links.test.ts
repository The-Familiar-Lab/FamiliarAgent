import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { CompositionStore } from "../composition/store.js";
import { ResultStore } from "../composition/result-store.js";
import {
  invokeResultCatalog,
  registerResultHandlers,
  resolveResultText,
} from "../composition/result-handlers.js";
import { ToolActions } from "./service.js";
import { ToolRunStore } from "./store.js";
import { captureToolResult, toolResultReader } from "./results.js";
import { resultAnchor } from "../../shared/results.js";
import type { ToolActionAdapter } from "./contracts.js";

const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => {
  for (const action of cleanup.splice(0).toReversed()) await action();
});
it("connects a completed original tool result to another native action exactly once in the same session", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "familiar-tool-links-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const composition = new CompositionStore(root);
  cleanup.push(() => composition.close());
  composition.saveProject({
    id: "project",
    title: "Tools",
    memory: "",
    resources: [],
    expectedRevision: 0,
    operationId: "project-save",
  });
  let session = composition.create({
    projectId: "project",
    title: "A",
    operationId: "create",
    endpoint: {
      kind: "tool",
      provider: "source",
      agentId: "source",
      serverId: "server",
      cwd: root,
    },
  });
  session = composition.bind({
    id: session.id,
    operationId: "bind-target",
    expectedRevision: session.revision,
    endpoint: {
      kind: "tool",
      provider: "target",
      agentId: "target",
      serverId: "server",
      cwd: root,
    },
  });
  const results = new ResultStore(
    root,
    (id) => composition.read(id),
    (tool, action) => tool === "target" && action === "run",
  );
  cleanup.push(() => results.close());
  const store = new ToolRunStore(path.join(root, "runs"), "server");
  let calls = 0;
  const adapters: ToolActionAdapter[] = ["source", "target"].map((id) => ({
    id,
    actions: [{ id: "run", label: "Run", description: "Native test process", input: true }],
    async execute(request, context) {
      calls++;
      const response = await context.exec({
        command: process.execPath,
        args: ["-e", "process.stdin.pipe(process.stdout)"],
        stdin: request.input,
      });
      return { state: "completed", text: response.stdout, nativeId: `original-${id}` };
    },
  }));
  const actions = new ToolActions(store, adapters, async (command) => command);
  cleanup.push(() => actions.close());
  await actions.start({
    operationId: "source-run",
    toolId: "source",
    action: "run",
    sessionId: session.id,
    cwd: root,
    parameters: {},
    input: "Selected native result 한글",
  });
  await actions.wait("source-run");
  const captured = captureToolResult(store, "source-run");
  const anchor = resultAnchor.parse(JSON.parse(JSON.stringify(captured.anchor)));
  const reader = toolResultReader(store);
  expect(await resolveResultText(anchor, reader)).toBe(captured.text);
  const prepare = {
    id: session.id,
    operationId: "input-target",
    expectedRevision: session.revision,
    sourceEndpointId: session.endpoints[0]!.id,
    targetEndpointId: session.endpoints[1]!.id,
    anchor,
    tool: { action: "run", parameters: {} },
    instruction: "Use this result",
  };
  expect(() => results.plan({ ...prepare, tool: { action: "exec", parameters: {} } })).toThrow(
    "does not accept composed prompts",
  );
  const planned = (await invokeResultCatalog(
    results,
    reader,
    "composition.input.prepare",
    prepare,
  )) as { text: string };
  expect(planned.text).toContain("Selected native result");
  expect(() =>
    results.plan({
      ...prepare,
      anchor: {
        ...anchor,
        resource: {
          ...anchor.resource,
          boundary: {
            kind: "tool",
            toolId: "other",
            cwd: root,
            sessionId: session.id,
            sha256: anchor.selection.sha256,
          },
        },
      },
    }),
  ).toThrow("does not match");
  const handlers = new Map<string, (input: unknown, context: unknown) => Promise<unknown>>();
  registerResultHandlers(
    {
      handle(
        contract: { name: string },
        handler: (input: unknown, context: unknown) => Promise<unknown>,
      ) {
        handlers.set(contract.name, handler);
      },
    } as unknown as PluginServerContext,
    {
      serverId: "server",
      actions,
      reader: () => reader,
      invoke: (method, input) => invokeResultCatalog(results, reader, method, input),
    },
  );
  const send = () =>
    handlers.get("composition.input.send")!(
      { id: session.id, inputId: "input-target" },
      { paseo: {} },
    );
  await Promise.all([send(), send()]);
  const run = await actions.wait("input-target");
  expect(run.state).toBe("completed");
  expect(run.result?.text).toBe(planned.text);
  expect(calls).toBe(2);
  await handlers.get("composition.input.reconcile")!(
    { id: session.id, inputId: "input-target" },
    { paseo: {} },
  );
  expect(results.read(session.id, "input-target").input.state).toBe("accepted");
  expect(results.list(session.id, 0, 30).total).toBe(1);
  expect(store.read("source-run").result?.text).toBe(captured.text);
  await invokeResultCatalog(results, reader, "composition.input.prepare", {
    ...prepare,
    operationId: "source-run",
  });
  await handlers.get("composition.input.send")!(
    { id: session.id, inputId: "source-run" },
    { paseo: {} },
  );
  await handlers.get("composition.input.reconcile")!(
    { id: session.id, inputId: "source-run" },
    { paseo: {} },
  );
  expect(results.read(session.id, "source-run").input.state).toBe("unknown");
  expect(results.read(session.id, "source-run").input.error).toContain("Operation ID");
  expect(calls).toBe(2);
  store.finish("source-run", "completed", { state: "completed", text: "Changed" }, null);
  await expect(resolveResultText(anchor, reader)).rejects.toThrow("no longer matches");
});
it("never exposes a native queue ACK as a completed result", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "familiar-tool-ack-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const store = new ToolRunStore(root, "server");
  cleanup.push(() => store.close());
  store.create(
    "run",
    {
      toolId: "tool",
      action: "send",
      sessionId: "session",
      cwd: root,
      input: "work",
      parameters: {},
    },
    true,
  );
  store.finish("run", "submitted", { state: "submitted", text: "queued", nativeId: "job" }, null);
  expect(() => captureToolResult(store, "run")).toThrow("not a completed result");
});
