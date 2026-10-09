import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, writeFile, appendFile, readFile, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import type { PaseoApi, PaseoAgent } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareCompositionInput } from "../../shared/results.js";
import { selectedResult, RESULT_TEXT_BYTE_LIMIT } from "../../shared/result-selection.js";
import { CompositionStore } from "./store.js";
import { ResultStore } from "./result-store.js";
import { captureResult, previewResult, readResultSource } from "./result-source.js";
import { textDigest, renderResultInput } from "./result-text.js";
import {
  invokeResultCatalog,
  registerResultHandlers,
  resolveResultText,
} from "./result-handlers.js";
import { localResourceReader } from "./readers.js";
import { BridgeRegistry, startReadOnlyBridge } from "./bridge.js";

const cleanup: Array<() => void | Promise<void>> = [];
function closeServer(server: Server) {
  return new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
}
afterEach(async () => {
  for (const action of cleanup.splice(0).toReversed()) await action();
  vi.unstubAllEnvs();
});
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "familiar-selected-result-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  vi.stubEnv("CODEX_HOME", root);
  const nativeId = "10000000-0000-4000-8000-000000000001";
  const folder = path.join(root, "sessions");
  await mkdir(folder);
  const file = path.join(folder, `${nativeId}.jsonl`);
  const texts = ["Old selected result 🧩", "Second selected part 한국어"];
  const record = (role: string, text: string) =>
    JSON.stringify({
      type: "response_item",
      payload: { type: "message", role, content: [{ type: "output_text", text }] },
    }) + "\n";
  const original =
    JSON.stringify({ type: "session_meta", payload: { id: nativeId } }) +
    "\n" +
    record("user", "DO NOT FORWARD original prompt") +
    record("assistant", texts[0]) +
    JSON.stringify({
      type: "response_item",
      payload: { type: "function_call_output", output: "DO NOT FORWARD tool output" },
    }) +
    "\n" +
    record("assistant", texts[1]) +
    record("user", "DO NOT FORWARD later prompt") +
    record("assistant", "DO NOT FORWARD later result");
  await writeFile(file, original);
  const snapshot = {
    id: "source",
    provider: "codex",
    status: "idle",
    persistence: { provider: "codex", sessionId: nativeId },
  } as PaseoAgent;
  const entries = texts.map((text, index) => ({
    seqStart: index * 3 + 2,
    seqEnd: index * 3 + 2,
    item: { type: "assistant_message", text, messageId: `message-${index}` },
  }));
  const refetch = vi.fn(async (input: { cursor: { seq: number } }) => ({
    epoch: "epoch",
    entries: entries.filter((entry) => entry.seqEnd < input.cursor.seq).slice(-2),
    error: null,
    staleCursor: false,
    gap: false,
  }));
  const refresh = vi.fn(async () => ({ agent: snapshot }));
  const send = vi.fn(async (_text: string, _options: unknown) => {});
  const messageReceipt = vi.fn(async () => ({ state: "pending", error: null, code: null }));
  const paseo = {
    agents: {
      ref: (id: string) =>
        id === "source" ? { refresh, timeline: { refetch } } : { send, messageReceipt },
    },
  } as unknown as PaseoApi;
  const selection = {
    segments: texts.map((text, index) => ({
      ...textDigest(text),
      cursor: { epoch: "epoch", seq: entries[index].seqEnd },
      messageId: `message-${index}`,
    })),
    ...textDigest(texts.join("\n\n")),
  };
  const captured = await captureResult(paseo, "mac", "source", selection);
  const composition = new CompositionStore(root);
  cleanup.push(() => composition.close());
  composition.saveProject({
    id: "project",
    operationId: "project",
    title: "Project",
    expectedRevision: 0,
    memory: "",
    resources: [],
  });
  const initial = composition.create({
    operationId: "session",
    projectId: "project",
    title: "Same logical session",
    endpoint: { serverId: "mac", agentId: "source", provider: "codex", cwd: root },
  });
  const session = composition.bind({
    operationId: "target",
    id: initial.id,
    expectedRevision: initial.revision,
    endpoint: { serverId: "ubuntu", agentId: "target", provider: "claude", cwd: root },
  });
  let results = new ResultStore(root, (id) => composition.read(id));
  cleanup.push(() => results.close());
  const request = prepareCompositionInput.input.parse({
    id: session.id,
    expectedRevision: session.revision,
    operationId: "input-one",
    sourceEndpointId: session.endpoints[0].id,
    targetEndpointId: session.endpoints[1].id,
    anchor: captured.anchor,
    instruction: "Review only this selected result",
  });
  const reader = localResourceReader({ serverId: "mac", paseo, history: {} as never });
  const handlers = new Map<string, (input: unknown, context: unknown) => Promise<unknown>>();
  const server = {
    handle: (
      contract: { name: string; input: { parse: (value: unknown) => unknown } },
      handler: (input: unknown, context: unknown) => Promise<unknown>,
    ) =>
      handlers.set(contract.name, (input, context) =>
        handler(contract.input.parse(input), context),
      ),
  } as unknown as PluginServerContext;
  const invoke = (method: string, input: Record<string, unknown>) =>
    invokeResultCatalog(results, reader, method, input);
  registerResultHandlers(server, { serverId: "ubuntu", invoke, reader: () => reader });
  const call = (method: string, input: unknown) => handlers.get(method)!(input, { paseo });
  const prepare = () =>
    invokeResultCatalog(results, reader, prepareCompositionInput.name, request) as Promise<
      ReturnType<ResultStore["prepare"]> & { text: string }
    >;
  return {
    root,
    file,
    texts,
    record,
    original,
    snapshot,
    refetch,
    refresh,
    send,
    messageReceipt,
    paseo,
    selection,
    captured,
    composition,
    session,
    request,
    reader,
    prepare,
    call,
    get results() {
      return results;
    },
    restart: () => {
      results.close();
      results = new ResultStore(root, (id) => composition.read(id));
    },
  };
}

describe("exact selected native result", () => {
  it("previews exact canonical text without original files, durable support or catalog mutation", async () => {
    const f = await fixture();
    await rm(f.file);
    await expect(captureResult(f.paseo, "mac", "source", f.selection)).rejects.toThrow();
    const input = { agentId: "source", selection: f.selection };
    expect(await f.call("composition.result.preview", input)).toEqual({ text: f.captured.text });
    f.snapshot.provider = "gemini";
    expect(await f.call("composition.result.preview", input)).toEqual({ text: f.captured.text });
    await expect(captureResult(f.paseo, "mac", "source", f.selection)).rejects.toThrow(
      "Copy input",
    );
    expect(f.results.list(f.session.id, 0, 30)).toEqual({ records: [], total: 0 });
    expect(f.composition.read(f.session.id)).toEqual(f.session);
  });
  it("rejects stale and changed canonical previews instead of copying unverified text", async () => {
    const f = await fixture();
    await expect(
      previewResult(f.paseo, "source", {
        ...f.selection,
        sha256: "0".repeat(64),
      }),
    ).rejects.toThrow();
    f.refetch.mockResolvedValue({
      epoch: "replacement",
      entries: [],
      error: null,
      staleCursor: true,
      gap: false,
    });
    await expect(previewResult(f.paseo, "source", f.selection)).rejects.toThrow(
      "cursor is no longer current",
    );
  });
  it("captures ordered assistant segments at chronological source positions without unrelated history", async () => {
    const f = await fixture();
    expect(f.captured.text).toBe(f.texts.join("\n\n"));
    expect(f.captured.anchor.selection.segments.map((segment) => segment.ordinal)).toEqual([1, 3]);
    expect(JSON.stringify(f.captured.anchor)).not.toContain(f.texts[0]);
    const prepared = await f.prepare();
    expect(prepared.text).toContain(f.texts[0]);
    expect(prepared.text).toContain(f.texts[1]);
    expect(prepared.text).not.toContain("DO NOT FORWARD");
    expect(await readFile(f.file, "utf8")).toBe(f.original);
    expect(f.composition.read(f.session.id)).toEqual(f.session);
  });
  it("keeps frozen selected ordinals across append, archive and projection restart", async () => {
    const f = await fixture();
    await appendFile(f.file, f.record("assistant", "Future result"));
    const archived = path.join(f.root, "archived_sessions");
    await mkdir(archived);
    await rename(f.file, path.join(archived, path.basename(f.file)));
    f.refetch.mockRejectedValue(new Error("Timeline is not available after restart"));
    expect((await readResultSource(f.snapshot, f.captured.anchor)).text).toBe(f.captured.text);
  });
  it("rejects rewritten originals rather than substituting another result", async () => {
    const f = await fixture();
    await writeFile(f.file, f.original.replace("Old selected", "New selected"));
    await expect(readResultSource(f.snapshot, f.captured.anchor)).rejects.toThrow("changed inside");
  });
  it("rejects a stale visible cursor even when matching text still exists", async () => {
    const f = await fixture();
    f.refetch.mockResolvedValue({
      epoch: "replacement",
      entries: [],
      error: null,
      staleCursor: true,
      gap: false,
    });
    await expect(captureResult(f.paseo, "mac", "source", f.selection)).rejects.toThrow(
      "cursor is no longer current",
    );
  });
  it("rejects ambiguous repeated original text and an active source", async () => {
    const f = await fixture();
    await appendFile(f.file, f.record("assistant", f.texts[0]));
    await expect(captureResult(f.paseo, "mac", "source", f.selection)).rejects.toThrow("ambiguous");
    f.snapshot.status = "running";
    await expect(captureResult(f.paseo, "mac", "source", f.selection)).rejects.toThrow("finish");
  });
  it("uses UTF-8 budgets and rejects partial or oversized selections", async () => {
    const f = await fixture();
    expect(f.selection.bytes).toBeGreaterThan(f.captured.text.length);
    expect(() => selectedResult.parse({ ...f.selection, bytes: f.selection.bytes - 1 })).toThrow();
    const text = "🧩".repeat(RESULT_TEXT_BYTE_LIMIT / 4 + 1);
    expect(() =>
      selectedResult.parse({
        ...textDigest(text),
        segments: [{ ...textDigest(text), cursor: { epoch: "epoch", seq: 1 } }],
      }),
    ).toThrow();
    await expect(
      resolveResultText(f.captured.anchor, async () => ({
        messages: [{ role: "assistant", text: "part" }],
        nextOffset: null,
        truncated: true,
      })),
    ).rejects.toThrow("truncated");
  });
});

describe("persistent selected-result input edges", () => {
  it("verifies ownership, native provider and target membership before recording an edge", async () => {
    const f = await fixture();
    const alien = {
      ...f.request,
      anchor: {
        ...f.captured.anchor,
        resource: { ...f.captured.anchor.resource, locator: "other-agent" },
      },
    };
    expect(() => f.results.plan(alien)).toThrow("source endpoint");
    expect(() => f.results.plan({ ...f.request, targetEndpointId: "external" })).toThrow(
      "same logical session",
    );
    expect(() => f.results.plan({ ...f.request, expectedRevision: 1 })).toThrow("changed");
    const planned = f.results.plan({
      ...f.request,
      anchor: {
        ...f.captured.anchor,
        resource: { ...f.captured.anchor.resource, connection: "ssh://unexpected-server" },
      },
    });
    expect(planned.resource.connection).toBeUndefined();
  });
  it("persists idempotent small records separately from session revisions", async () => {
    const f = await fixture();
    const first = await f.prepare();
    expect((await f.prepare()).input.id).toBe(first.input.id);
    f.restart();
    expect(f.results.read(f.session.id, first.input.id)).toEqual({
      input: first.input,
      result: first.result,
    });
    expect(f.results.list(f.session.id, 0, 10).total).toBe(1);
    expect(() => f.results.replay({ ...f.request, instruction: "Different input" })).toThrow(
      "different result input",
    );
    expect(f.composition.read(f.session.id).revision).toBe(f.session.revision);
  });
  it("allows only one dispatch claim and binds completion to its target and token", async () => {
    const f = await fixture();
    await f.prepare();
    expect(() => f.results.claim(f.session.id, "input-one", "wrong-host")).toThrow(
      "different target",
    );
    const claim = f.results.claim(f.session.id, "input-one", "ubuntu");
    expect(claim.claimed).toBe(true);
    expect(f.results.claim(f.session.id, "input-one", "ubuntu").claimed).toBe(false);
    expect(() =>
      f.results.finish({
        id: f.session.id,
        inputId: "input-one",
        token: "wrong",
        targetServerId: "ubuntu",
        targetAgentId: "target",
        state: "accepted",
        error: null,
      }),
    ).toThrow("claim");
    expect(() =>
      f.results.finish({
        id: f.session.id,
        inputId: "input-one",
        token: claim.token!,
        targetServerId: "ubuntu",
        targetAgentId: "other",
        state: "accepted",
        error: null,
      }),
    ).toThrow("different target");
  });
  it("concurrent Send input requests create only one native user input", async () => {
    const f = await fixture();
    await f.prepare();
    await Promise.all([
      f.call("composition.input.send", { id: f.session.id, inputId: "input-one" }),
      f.call("composition.input.send", { id: f.session.id, inputId: "input-one" }),
    ]);
    expect(f.send).toHaveBeenCalledOnce();
    expect(f.send.mock.calls[0][1]).toEqual({
      messageId: "input-one",
      activeTurnBehavior: "reject",
    });
    expect(f.results.read(f.session.id, "input-one").input.state).toBe("accepted");
  });
  it("records explicit busy rejection as failed without steering or retry", async () => {
    const f = await fixture();
    await f.prepare();
    f.send.mockRejectedValue(
      Object.assign(new Error("Target is busy"), { deliveryState: "rejected" }),
    );
    await f.call("composition.input.send", { id: f.session.id, inputId: "input-one" });
    expect(f.results.read(f.session.id, "input-one").input.state).toBe("failed");
    await f.call("composition.input.send", { id: f.session.id, inputId: "input-one" });
    expect(f.send).toHaveBeenCalledOnce();
  });
  it("survives lost acknowledgements and reconciles native receipts without another send", async () => {
    const f = await fixture();
    await f.prepare();
    f.send.mockRejectedValue(new Error("Connection closed after dispatch"));
    await f.call("composition.input.send", { id: f.session.id, inputId: "input-one" });
    expect(f.results.read(f.session.id, "input-one").input.state).toBe("unknown");
    f.restart();
    await f.call("composition.input.send", { id: f.session.id, inputId: "input-one" });
    await f.call("composition.input.reconcile", { id: f.session.id, inputId: "input-one" });
    expect(f.results.read(f.session.id, "input-one").input.state).toBe("unknown");
    f.messageReceipt.mockResolvedValue({ state: "completed", error: null, code: null });
    await f.call("composition.input.reconcile", { id: f.session.id, inputId: "input-one" });
    expect(f.results.read(f.session.id, "input-one").input.state).toBe("accepted");
    expect(f.send).toHaveBeenCalledOnce();
    expect(f.messageReceipt.mock.calls[1][1]).toEqual({
      text: renderResultInput(f.captured.anchor, f.captured.text, f.request.instruction),
      activeTurnBehavior: "reject",
    });
  });
  it("fails before native send when the prepared original was rewritten", async () => {
    const f = await fixture();
    await f.prepare();
    await writeFile(f.file, f.original.replace("Old selected", "New selected"));
    await f.call("composition.input.send", { id: f.session.id, inputId: "input-one" });
    expect(f.send).not.toHaveBeenCalled();
    expect(f.results.read(f.session.id, "input-one").input.state).toBe("failed");
  });
  it("reads exact selected source ordinals through the existing scoped HTTP return path", async () => {
    const f = await fixture();
    const token = randomBytes(32).toString("hex");
    const ref = f.captured.anchor.resource;
    const { server, port } = await startReadOnlyBridge({
      token,
      resources: new Set([`${ref.serverId}\0${ref.format}\0${ref.locator}`]),
      reader: f.reader,
    });
    cleanup.push(() => closeServer(server));
    const registry = new BridgeRegistry(path.join(f.root, "receiving"), "ubuntu");
    await registry.install({ sourceServerId: "mac", targetServerId: "ubuntu", port, token });
    expect(await resolveResultText(f.captured.anchor, (await registry.reader(ref))!)).toBe(
      f.captured.text,
    );
  });
  it("limits linked catalog claim/receipt mutations to the allowed logical session and its stored target", async () => {
    const f = await fixture();
    await f.prepare();
    const token = randomBytes(32).toString("hex");
    const { server, port } = await startReadOnlyBridge({
      token,
      resources: new Set(),
      reader: f.reader,
      sessions: new Map([[f.session.id, undefined]]),
      targetServerId: "ubuntu",
      catalog: (method, input) => invokeResultCatalog(f.results, f.reader, method, input),
    });
    cleanup.push(() => closeServer(server));
    const request = (method: string, input: unknown) =>
      fetch(`http://127.0.0.1:${port}/catalog`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ method, input }),
      });
    expect(
      (
        await request("composition.input.claim", {
          id: "another-session",
          inputId: "input-one",
          targetServerId: "ubuntu",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request("composition.input.claim", {
          id: f.session.id,
          inputId: "input-one",
          targetServerId: "wrong-server",
        })
      ).status,
    ).toBe(400);
    expect(
      (await request("composition.input.send", { id: f.session.id, inputId: "input-one" })).status,
    ).toBe(400);
    const response = await request("composition.input.claim", {
      id: f.session.id,
      inputId: "input-one",
      targetServerId: "ubuntu",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ claimed: true, input: { state: "unknown" } });
    expect(f.send).not.toHaveBeenCalled();
  });
});
