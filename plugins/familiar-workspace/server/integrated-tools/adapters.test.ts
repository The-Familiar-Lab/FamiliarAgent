import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolActionContext, ToolActionRequest } from "../tool-actions/contracts.js";
import { INTEGRATED_TOOL_ADAPTERS } from "./index.js";
import { endpoint, tokenFile } from "./common.js";

let root: string;
let context: ToolActionContext;
const run = (toolId: string, action: string, values: Partial<ToolActionRequest> = {}) =>
  INTEGRATED_TOOL_ADAPTERS.find((tool) => tool.id === toolId)!.execute(
    {
      toolId,
      action,
      cwd: root,
      sessionId: "same-logical-session",
      input: "selected result; $(not-a-shell)",
      parameters: {},
      ...values,
    },
    context,
  );

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "familiar-integrated-"));
  context = {
    runDirectory: root,
    signal: new AbortController().signal,
    resolveCommand: vi.fn(async (command) => command),
    exec: vi.fn(async () => ({ stdout: "{}", stderr: "", exitCode: 0 })),
    request: vi.fn(async () => ({ status: 200, body: "{}" })),
  };
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("native tool boundaries", () => {
  it("installs Codeg's original ACP adapter without silently cleaning existing native files", async () => {
    const path = join(root, "codeg-token");
    await writeFile(path, "private-test-token");
    vi.mocked(context.request).mockResolvedValue({
      status: 200,
      body: JSON.stringify("/native/agent-entry"),
    });
    const result = await run("codeg", "prepare-agent", {
      parameters: { url: "http://127.0.0.1:3000", tokenFile: path, agentType: "claude_code" },
    });
    expect(result.state).toBe("completed");
    expect(context.request).toHaveBeenCalledWith(
      expect.objectContaining({
        timeoutMs: 180_000,
        body: {
          agentType: "claude_code",
          cleanFirst: false,
          registryVersion: null,
          version: null,
          taskId: expect.any(String),
        },
      }),
    );
    vi.mocked(context.request).mockResolvedValue({ status: 200, body: "null" });
    await expect(
      run("codeg", "prepare-agent", {
        parameters: { url: "http://127.0.0.1:3000", tokenFile: path, agentType: "claude_code" },
      }),
    ).rejects.toThrow("did not return an installed");
  });
  it("passes Orca input as one literal argv and reports submission, not completion", async () => {
    const result = await run("orca", "send", { nativeId: "term-1" });
    expect(result.state).toBe("submitted");
    expect(context.exec).toHaveBeenCalledWith(
      expect.objectContaining({
        args: [
          "terminal",
          "send",
          "--terminal",
          "term-1",
          "--text",
          "selected result; $(not-a-shell)",
          "--enter",
          "--wait-submit",
          "5",
          "--json",
        ],
      }),
    );
  });
  it("requires an explicit terminal for a read instead of borrowing the active one", async () => {
    await expect(run("orca", "read")).rejects.toThrow("native session");
    expect(context.exec).not.toHaveBeenCalled();
  });
  it("bounds Orca retained-output reads and rejects invalid cursors", async () => {
    await expect(
      run("orca", "read", { nativeId: "a", parameters: { limit: "999999" } }),
    ).rejects.toThrow("2000");
    await expect(
      run("orca", "read", { nativeId: "a", parameters: { cursor: "-1" } }),
    ).rejects.toThrow("cursor");
  });
  it("uses Hydra's actual Unix socket headless payload and preserves its run ID", async () => {
    vi.mocked(context.request).mockResolvedValue({
      status: 201,
      body: JSON.stringify({ id: "native-run", status: "running" }),
    });
    const result = await run("hydra", "run", {
      parameters: { socketPath: join(root, "hydra.sock"), model: "native-model" },
    });
    expect(result).toMatchObject({ state: "submitted", nativeId: "native-run" });
    expect(context.request).toHaveBeenCalledWith(
      expect.objectContaining({
        socketPath: join(root, "hydra.sock"),
        body: {
          prompt: "selected result; $(not-a-shell)",
          projectDir: root,
          provider: "claude",
          model: "native-model",
        },
      }),
    );
  });
  it("does not treat Hydra API failure as a submitted job", async () => {
    vi.mocked(context.request).mockResolvedValue({
      status: 500,
      body: '{"error":"private diagnostic"}',
    });
    await expect(
      run("hydra", "list", { parameters: { socketPath: join(root, "s") } }),
    ).rejects.toThrow("HTTP 500");
  });
  it("reads Codeg credentials at invocation and does not return or save them", async () => {
    const tokenPath = join(root, "token");
    await writeFile(tokenPath, "private-token\n");
    vi.mocked(context.request).mockResolvedValue({
      status: 200,
      body: '[{"id":12,"title":"native"}]',
    });
    const output = await run("codeg", "list", {
      parameters: { url: "http://localhost:3080", tokenFile: tokenPath },
    });
    expect(context.request).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "http://localhost:3080/api/list_all_conversations",
        headers: { Authorization: "Bearer private-token" },
      }),
    );
    expect(output.text).not.toContain("private-token");
    expect(await readdir(root)).toEqual(["token"]);
  });
  it("uses Codeg's bounded native turn window", async () => {
    const path = join(root, "token");
    await writeFile(path, "token");
    await run("codeg", "read", {
      nativeId: "17",
      parameters: { url: "http://localhost:3080", tokenFile: path, turns: "3" },
    });
    expect(context.request).toHaveBeenCalledWith(
      expect.objectContaining({ body: { conversationId: 17, tailTurns: 3 } }),
    );
  });
  it("refuses unsupported Alethe permission flags before creating a worker", async () => {
    vi.mocked(context.exec).mockResolvedValue({
      stdout: JSON.stringify({
        result: {
          tools: [{ name: "alethe_delegate", inputSchema: { properties: { tasks: {} } } }],
        },
      }),
      stderr: "",
      exitCode: 0,
    });
    await expect(
      run("alethe", "run", {
        parameters: { command: "alethe-orchestrator-mcp", codexCommand: "codex", readOnly: "true" },
      }),
    ).rejects.toThrow("does not support readOnly");
    expect(context.exec).toHaveBeenCalledTimes(1);
    expect(JSON.parse(vi.mocked(context.exec).mock.calls[0][0].stdin!)).toMatchObject({
      method: "tools/list",
    });
  });
  it("loads a selected native skill plugin only for this Claude invocation", async () => {
    const path = join(root, "plugin");
    await mkdir(join(path, ".claude-plugin"), { recursive: true });
    await writeFile(
      join(path, ".claude-plugin/plugin.json"),
      JSON.stringify({ name: "python-development" }),
    );
    vi.mocked(context.exec).mockResolvedValue({
      stdout: JSON.stringify({
        result: "skill used",
        session_id: "original-claude",
        is_error: false,
      }),
      stderr: "",
      exitCode: 0,
    });
    expect(await run("agents", "run", { parameters: { pluginPath: path } })).toMatchObject({
      nativeId: "original-claude",
      state: "completed",
    });
    expect(context.exec).toHaveBeenCalledWith(
      expect.objectContaining({
        args: [
          "--plugin-dir",
          await realpath(path),
          "--output-format",
          "json",
          "-p",
          "selected result; $(not-a-shell)",
        ],
      }),
    );
  });
  it("does not overwrite an existing unrelated Codey data directory", async () => {
    const data = join(root, "existing");
    await mkdir(data);
    await writeFile(join(data, "gateway.json"), "original");
    await expect(
      run("codey", "list", {
        parameters: { moduleRoot: root, dataRoot: data, nodeCommand: "node" },
      }),
    ).rejects.toThrow("empty dedicated");
    expect(await readFile(join(data, "gateway.json"), "utf8")).toBe("original");
    expect(context.exec).not.toHaveBeenCalled();
  });
  it("releases the dedicated Codey profile lock after native failure without deleting native data", async () => {
    const data = join(root, "dedicated");
    vi.mocked(context.exec).mockResolvedValue({
      stdout: "",
      stderr: "native failure",
      exitCode: 1,
    });
    await expect(
      run("codey", "run", {
        parameters: { moduleRoot: root, dataRoot: data, nodeCommand: "node" },
      }),
    ).rejects.toThrow("native failure");
    const entries = await readdir(data);
    expect(entries).toContain("gateway.json");
    expect(entries).not.toContain(".familiar-active");
  });
  it("uses Harness's native argument separator for literal task input", async () => {
    vi.mocked(context.exec).mockResolvedValue({
      stdout: JSON.stringify({ ok: true, agent: { id: "original-agent" } }),
      stderr: "",
      exitCode: 0,
    });
    const result = await run("openharness", "run", { parameters: { agent: "claude" } });
    expect(result).toMatchObject({ state: "submitted", nativeId: "original-agent" });
    expect(context.exec).toHaveBeenCalledWith(
      expect.objectContaining({
        args: [
          "new",
          "claude",
          root,
          "--mode",
          "ask",
          "--json",
          "--",
          "selected result; $(not-a-shell)",
        ],
      }),
    );
  });
  it("does not claim Harness accepted an unacknowledged native agent", async () => {
    await expect(run("openharness", "run", { parameters: { agent: "claude" } })).rejects.toThrow(
      "did not acknowledge",
    );
  });
  it("rejects credential-bearing URLs and multiline or oversized credential files", async () => {
    expect(() => endpoint("http://user:pass@localhost", "api")).toThrow("without credentials");
    const path = join(root, "token");
    await writeFile(path, "first\nsecond");
    await expect(tokenFile(path)).rejects.toThrow("one nonempty token");
    await writeFile(path, "x".repeat(4097));
    await expect(tokenFile(path)).rejects.toThrow("small regular");
  });
});

describe("verified native continuation contracts", () => {
  it("Codeg resumes the owning folder and supplies both required IDs before sending", async () => {
    const path = join(root, "token");
    await writeFile(path, "token");
    vi.mocked(context.request)
      .mockResolvedValueOnce({
        status: 200,
        body: JSON.stringify({
          summary: { folder_id: 7, agent_type: "claude_code", external_id: "native-session" },
        }),
      })
      .mockResolvedValueOnce({ status: 200, body: "null" })
      .mockResolvedValueOnce({
        status: 200,
        body: JSON.stringify({ path: "/native/owning-folder" }),
      })
      .mockResolvedValueOnce({ status: 200, body: '"native-connection"' })
      .mockResolvedValueOnce({ status: 200, body: "null" });
    const output = await run("codeg", "send", {
      nativeId: "17",
      parameters: { url: "http://localhost:3080", tokenFile: path },
    });
    expect(context.request).toHaveBeenNthCalledWith(
      4,
      expect.objectContaining({
        body: {
          agentType: "claude_code",
          workingDir: "/native/owning-folder",
          sessionId: "native-session",
        },
      }),
    );
    expect(context.request).toHaveBeenLastCalledWith(
      expect.objectContaining({
        body: {
          connectionId: "native-connection",
          folderId: 7,
          conversationId: 17,
          blocks: [{ type: "text", text: "selected result; $(not-a-shell)" }],
        },
      }),
    );
    expect(output.state).toBe("submitted");
  });
  it("Codeg does not send when its owning conversation cannot be established", async () => {
    const path = join(root, "token");
    await writeFile(path, "token");
    await expect(
      run("codeg", "send", {
        nativeId: "17",
        parameters: { url: "http://localhost:3080", tokenFile: path },
      }),
    ).rejects.toThrow();
    expect(context.request).toHaveBeenCalledTimes(1);
  });
  it("writes a guarded Hydra launcher without starting the original runtime", async () => {
    const source = join(root, "hydra");
    await mkdir(join(source, "out/main"), { recursive: true });
    await writeFile(join(source, "package.json"), JSON.stringify({ version: "0.2.61" }));
    const output = await run("hydra", "prepare", {
      parameters: {
        socketPath: join(root, "daemon.sock"),
        dataRoot: join(root, "state"),
        daemonPath: join(source, "out/main/daemon.js"),
      },
    });
    const content = await readFile(output.artifacts![0]!.path, "utf8");
    expect(content).toContain("--verbose");
    expect(content).toContain("process.argv=");
    expect(context.exec).not.toHaveBeenCalled();
    await writeFile(join(source, "package.json"), JSON.stringify({ version: "1.0.0" }));
    await expect(
      run("hydra", "prepare", {
        parameters: {
          socketPath: join(root, "daemon.sock"),
          dataRoot: join(root, "state"),
          daemonPath: join(source, "out/main/daemon.js"),
        },
      }),
    ).rejects.toThrow("verified Hydra");
  });
});

it("preserves the original Orca terminal handle for subsequent send/read actions", async () => {
  vi.mocked(context.exec).mockResolvedValue({
    exitCode: 0,
    stderr: "",
    stdout: JSON.stringify({ ok: true, result: { terminal: { handle: "original-terminal" } } }),
  });
  expect(await run("orca", "create")).toMatchObject({
    nativeId: "original-terminal",
    state: "completed",
  });
});

it("rejects missing skill assistant output even if native metadata says success", async () => {
  const selected = join(root, "plugin");
  await mkdir(join(selected, ".claude-plugin"), { recursive: true });
  await writeFile(
    join(selected, ".claude-plugin/plugin.json"),
    JSON.stringify({ name: "native-plugin" }),
  );
  for (const output of [
    { is_error: false, session_id: "native" },
    { is_error: false, result: "   " },
    { is_error: false, result: { text: "not a native result string" } },
  ]) {
    vi.mocked(context.exec).mockResolvedValue({
      stdout: JSON.stringify(output),
      stderr: "",
      exitCode: 0,
    });
    await expect(run("agents", "run", { parameters: { pluginPath: selected } })).rejects.toThrow(
      "assistant result",
    );
  }
  vi.mocked(context.exec).mockResolvedValue({
    stdout: JSON.stringify({
      is_error: false,
      result: "Actual assistant text",
      session_id: "original-session",
      usage: { input_tokens: 1 },
    }),
    stderr: "",
    exitCode: 0,
  });
  expect(await run("agents", "run", { parameters: { pluginPath: selected } })).toEqual({
    state: "completed",
    text: "Actual assistant text",
    nativeId: "original-session",
  });
});
