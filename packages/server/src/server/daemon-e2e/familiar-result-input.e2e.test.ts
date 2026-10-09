import { createHash } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { createDaemonTestContext, type DaemonTestContext } from "../test-utils/index.js";
import { BuiltinPluginLoader } from "../plugins/builtin/index.js";
import { compositionSession } from "../../../../../plugins/familiar-workspace/shared/composition.js";
import {
  captureCompositionResult,
  compositionInputRecord,
  listCompositionInputs,
  prepareCompositionInput,
} from "../../../../../plugins/familiar-workspace/shared/results.js";

let context: DaemonTestContext | undefined;
let root: string | undefined;
afterEach(async () => {
  await context?.cleanup();
  if (root) await rm(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const nativeRecord = (role: "user" | "assistant", text: string) =>
  JSON.stringify({
    type: "response_item",
    payload: { type: "message", role, content: [{ type: "output_text", text }] },
  }) + "\n";

test("real daemon sends only the selected old response, retaining its logical session and one input edge", async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "familiar-result-input-"));
  const home = path.join(root, ".paseo");
  const nativeHome = path.join(root, "codex-fixture");
  const productRoot = path.resolve(import.meta.dirname, "../../../../..");
  vi.stubEnv("PASEO_HOME", home);
  vi.stubEnv("CODEX_HOME", nativeHome);
  context = await createDaemonTestContext({
    paseoHomeRoot: root,
    pluginsEnabled: true,
    builtinPlugins: new BuiltinPluginLoader(path.join(productRoot, "plugins"), [
      "familiar-workspace",
    ]),
  });
  const rpc = async (method: string, input: unknown) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        context!.client.invokePluginRpc("familiar-workspace", method, input),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`${method} did not finish within 8 seconds`)),
            8000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const serverId = (await readFile(path.join(home, "server-id"), "utf8")).trim();
  const selected = `SELECTED_RESULT: 안녕 🧩 ${"chosen-data ".repeat(100).trimEnd()}`;
  const originalPrompt = `ORIGINAL_INSTRUCTION_DO_NOT_FORWARD\nRespond with exactly: ${selected}`;
  const source = await context.client.createAgent({
    provider: "codex",
    cwd: root,
    title: "Source",
    initialPrompt: originalPrompt,
    clientMessageId: "source-first",
  });
  await context.client.waitForFinish(source.id, 5000);
  const firstTimeline = await context.client.fetchAgentTimeline(source.id, {
    projection: "canonical",
    direction: "tail",
    limit: 100,
  });
  const entry = firstTimeline.entries.find(
    (row) => row.item.type === "assistant_message" && row.item.text === selected,
  );
  expect(entry).toBeTruthy();
  const selection = {
    segments: [
      {
        cursor: { epoch: firstTimeline.epoch, seq: entry!.seqEnd },
        sha256: digest(selected),
        bytes: Buffer.byteLength(selected),
      },
    ],
    sha256: digest(selected),
    bytes: Buffer.byteLength(selected),
  };
  // Manual copy remains available from the canonical response before an original file exists.
  expect(await rpc("composition.result.preview", { agentId: source.id, selection })).toEqual({
    text: selected,
  });
  const nativeId = (await context.client.fetchAgent(source.id))?.agent.persistence?.sessionId;
  expect(nativeId).toBeTruthy();
  await mkdir(path.join(nativeHome, "sessions"), { recursive: true });
  const sourceFile = path.join(nativeHome, "sessions", `${nativeId}.jsonl`);
  // The fake native provider supplies canonical events; this is its matching original transcript.
  await writeFile(
    sourceFile,
    JSON.stringify({ type: "session_meta", payload: { id: nativeId } }) +
      "\n" +
      nativeRecord("user", originalPrompt) +
      nativeRecord("assistant", selected),
  );
  const later = "LATER_RESULT_NOT_SELECTED";
  await context.client.sendMessage(source.id, `Respond with exactly: ${later}`, {
    messageId: "source-later",
  });
  await context.client.waitForFinish(source.id, 5000);
  await appendFile(
    sourceFile,
    nativeRecord("user", "NEWER_PROMPT_DO_NOT_FORWARD") + nativeRecord("assistant", later),
  );

  const captured = captureCompositionResult.output.parse(
    await rpc("composition.result.capture", {
      agentId: source.id,
      selection,
    }),
  );
  expect(captured.text).toBe(selected);
  await expect(
    rpc("composition.result.capture", {
      agentId: source.id,
      selection: {
        ...selection,
        segments: [
          { ...selection.segments[0], cursor: { epoch: "stale-epoch", seq: entry!.seqEnd } },
        ],
      },
    }),
  ).rejects.toThrow();
  await appendFile(sourceFile, nativeRecord("assistant", "AFTER_CAPTURE_NEVER_FORWARD"));
  const sourceBeforeDispatch = await readFile(sourceFile, "utf8");
  const target = await context.client.createAgent({
    provider: "claude",
    cwd: root,
    title: "Target",
  });
  await rpc("composition.project.save", {
    operationId: "result-project",
    id: "result-project",
    title: "Result project",
    expectedRevision: 0,
    memory: "",
    resources: [],
  });
  const session = compositionSession.parse(
    await rpc("composition.create", {
      operationId: "result-session",
      projectId: "result-project",
      title: "One logical session",
      endpoint: { serverId, agentId: source.id, provider: "codex", cwd: root },
    }),
  );
  const bound = compositionSession.parse(
    await rpc("composition.bind", {
      operationId: "result-target",
      id: session.id,
      expectedRevision: session.revision,
      endpoint: { serverId, agentId: target.id, provider: "claude", cwd: root },
    }),
  );
  const prepared = prepareCompositionInput.output.parse(
    await rpc("composition.input.prepare", {
      operationId: "selected-input",
      id: session.id,
      expectedRevision: bound.revision,
      sourceEndpointId: bound.endpoints.find((endpoint) => endpoint.agentId === source.id)!.id,
      targetEndpointId: bound.endpoints.find((endpoint) => endpoint.agentId === target.id)!.id,
      anchor: captured.anchor,
      instruction: "Explain this selected result.",
    }),
  );
  expect(prepared.input.state).toBe("prepared");
  expect(
    await context.client.getAgentMessageReceipt(target.id, prepared.input.id, {
      text: prepared.text,
      activeTurnBehavior: "reject",
    }),
  ).toMatchObject({ state: "absent" });
  const accepted = compositionInputRecord.parse(
    await rpc("composition.input.send", {
      id: session.id,
      inputId: prepared.input.id,
    }),
  );
  expect(accepted.input.state).toBe("accepted");
  expect(
    await context.client.getAgentMessageReceipt(target.id, prepared.input.id, {
      text: prepared.text,
      activeTurnBehavior: "reject",
    }),
  ).toMatchObject({ state: "completed" });
  expect(accepted.input.sessionId).toBe(session.id);
  expect(accepted.result.anchor).toEqual(captured.anchor);
  const duplicate = compositionInputRecord.parse(
    await rpc("composition.input.send", {
      id: session.id,
      inputId: prepared.input.id,
    }),
  );
  expect(duplicate.input.id).toBe(accepted.input.id);
  await context.client.waitForFinish(target.id, 5000);
  const targetTimeline = await context.client.fetchAgentTimeline(target.id, {
    projection: "canonical",
    direction: "tail",
    limit: 100,
  });
  const inputs = targetTimeline.entries.flatMap((row) =>
    row.item.type === "user_message" ? [row.item.text] : [],
  );
  expect(inputs).toHaveLength(1);
  expect(inputs[0]).toContain(selected);
  expect(inputs[0]).toContain("Explain this selected result.");
  for (const excluded of [
    "ORIGINAL_INSTRUCTION_DO_NOT_FORWARD",
    later,
    "NEWER_PROMPT_DO_NOT_FORWARD",
    "AFTER_CAPTURE_NEVER_FORWARD",
  ])
    expect(inputs[0]).not.toContain(excluded);
  expect(await readFile(sourceFile, "utf8")).toBe(sourceBeforeDispatch);
  const lineage = listCompositionInputs.output.parse(
    await rpc("composition.inputs.list", { id: session.id }),
  );
  expect(lineage.total).toBe(1);
  expect(lineage.records[0].input.id).toBe(accepted.input.id);
  expect(lineage.records[0].result.anchor.resource.locator).toBe(source.id);
  expect(JSON.stringify(lineage.records[0])).not.toContain(selected);
}, 30000);
