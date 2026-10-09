import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ToolActionContext,
  ToolActionRequest,
  ToolCommand,
} from "../tool-actions/contracts.js";
import { aiderAdapter, aiderReply } from "./aider.js";
import { gooseAdapter, gooseReply, gooseRestartContext, resumedGooseExtensions } from "./goose.js";
import { openrigAdapter } from "./openrig.js";
import { isClaudeComposerIdle, squadAdapter } from "./squad.js";
import { superharnessAdapter } from "./superharness.js";

let root: string;
let context: ToolActionContext;
let request: ToolActionRequest;
const exec = vi.fn<ToolActionContext["exec"]>();
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "familiar-native-' "));
  context = {
    runDirectory: root,
    signal: new AbortController().signal,
    resolveCommand: async (command) => command,
    exec,
    request: vi.fn(),
  };
  request = {
    toolId: "",
    action: "run",
    cwd: root,
    sessionId: "logical",
    input: "Literal `cmd` $(touch bad) 'quotes'\nsecond line",
    parameters: {},
  };
  exec.mockReset().mockResolvedValue({ stdout: "native result", stderr: "", exitCode: 0 });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("native tools", () => {
  it("recognizes a verified idle Claude composer and rejects busy or permission dialogs", () => {
    expect(isClaudeComposerIdle("● reply\n────────\n❯ \n────────\n  auto mode on")).toBe(true);
    expect(isClaudeComposerIdle("Do you want to proceed?\n❯ 1. Yes\nEsc to cancel")).toBe(false);
    expect(isClaudeComposerIdle("✻ Working…\n────────\n❯ \n────────\nEsc to interrupt")).toBe(
      false,
    );
  });
  it("does not call Aider authentication errors a result even after exit zero", () => {
    expect(() => aiderReply("#### request  \n> AuthenticationError\n> URL\n", "request")).toThrow(
      "no assistant",
    );
    expect(
      aiderReply("#### request  \n\nNative reply\n#### response heading\n> quoted text", "request"),
    ).toBe("Native reply\n#### response heading\n> quoted text");
  });
  it("passes Aider exact input through a private file and retains native history", async () => {
    const loggedInput = request.input
      .split("\n")
      .map((line) => `#### ${line}`)
      .join("  \n");
    exec.mockImplementation(async (command) => {
      const input = command.args[command.args.indexOf("--message-file") + 1]!;
      expect(await readFile(input, "utf8")).toBe(request.input);
      const history = command.args[command.args.indexOf("--chat-history-file") + 1]!;
      await writeFile(history, loggedInput + "  \n\nActual native response\n");
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    expect(await aiderAdapter.execute(request, context)).toMatchObject({
      state: "completed",
      text: "Actual native response",
      nativeId: path.join(root, "aider.chat.history.md"),
    });
    expect(exec.mock.calls[0]![0].args).not.toContain(request.input);
    expect(exec.mock.calls[0]![0].env).toMatchObject({ AIDER_YES_ALWAYS: "false" });
  });
  it("passes only a private environment path to native Aider and rejects public or linked files", async () => {
    const filename = path.join(root, "provider's key.env");
    const secret = "private-test-key";
    await writeFile(filename, `OPENAI_API_KEY=${secret}\n`, { mode: 0o600 });
    exec.mockResolvedValue({ stdout: "", stderr: "", exitCode: 7 });
    await expect(
      aiderAdapter.execute({ ...request, parameters: { envFile: filename } }, context),
    ).rejects.toThrow("code 7");
    const command = exec.mock.calls[0]![0];
    expect(command.args[command.args.indexOf("--env-file") + 1]).toBe(filename);
    expect(JSON.stringify(command)).not.toContain(secret);
    exec.mockClear();
    await chmod(filename, 0o644);
    await expect(
      aiderAdapter.execute({ ...request, parameters: { envFile: filename } }, context),
    ).rejects.toThrow("0600");
    await chmod(filename, 0o600);
    const link = path.join(root, "linked.env");
    await symlink(filename, link);
    await expect(
      aiderAdapter.execute({ ...request, parameters: { envFile: link } }, context),
    ).rejects.toThrow("regular file");
    expect(exec).not.toHaveBeenCalled();
  });
  it("fails native nonzero exits without leaking native stderr into errors", async () => {
    exec.mockResolvedValue({ stdout: "", stderr: "secret token", exitCode: 4 });
    await expect(gooseAdapter.execute({ ...request, action: "list" }, context)).rejects.toThrow(
      "code 4",
    );
  });
  it("requires Goose native completion and an assistant response", () => {
    expect(() =>
      gooseReply(JSON.stringify({ metadata: { status: "error" }, messages: [] })),
    ).toThrow("completed");
    expect(
      gooseReply(
        JSON.stringify({
          metadata: { status: "completed" },
          messages: [{ role: "assistant", content: [{ type: "text", text: "reply" }] }],
        }),
      ),
    ).toBe("reply");
  });
  it("identifies the created Goose session and passes the original shared MCP extension", async () => {
    context.nativeContext = vi.fn().mockResolvedValue({
      args: ["--with-extension", "literal extension"],
      env: { FAMILIAR_SESSION_ID: "logical" },
    });
    exec.mockResolvedValueOnce({
      stdout: JSON.stringify({
        metadata: { status: "completed" },
        messages: [{ role: "assistant", content: [{ type: "text", text: "reply" }] }],
      }),
      stderr: "",
      exitCode: 0,
    });
    exec.mockResolvedValueOnce({
      stdout: JSON.stringify([
        { id: "20261009_1", name: `familiar-${path.basename(root)}`, working_dir: root },
      ]),
      stderr: "",
      exitCode: 0,
    });
    expect(await gooseAdapter.execute(request, context)).toEqual({
      state: "completed",
      text: "reply",
      nativeId: "20261009_1",
    });
    expect(exec.mock.calls[0]![0].args).toContain("literal extension");
    expect(exec.mock.calls[0]![0].env).toMatchObject({ FAMILIAR_SESSION_ID: "logical" });
  });
  it("reuses only the exact native persisted Familiar extension on Goose resume", () => {
    const extension = {
      type: "stdio",
      name: "familiar_context",
      cmd: "/bin/sh",
      args: ["-c", "exec exact command"],
      envs: {},
      env_keys: [],
      cwd: null,
    };
    const session = { extension_data: { "enabled_extensions.v0": { extensions: [extension] } } };
    const args = ["--with-extension", "familiar_context:/bin/sh -c 'exec exact command'"];
    expect(resumedGooseExtensions(session, args)).toEqual([]);
    expect(resumedGooseExtensions(undefined, args)).toEqual(args);
    expect(() =>
      resumedGooseExtensions(session, [
        "--with-extension",
        "familiar_context:/bin/sh -c 'different command'",
      ]),
    ).toThrow("different familiar_context");
    expect(() =>
      resumedGooseExtensions(
        {
          extension_data: {
            "enabled_extensions.v0": {
              extensions: [{ ...extension, envs: { FAMILIAR_MCP_HOME: "foreign" } }],
            },
          },
        },
        args,
      ),
    ).toThrow("different familiar_context");
  });
  it("restores bounded native history for Goose's process-local Claude provider", async () => {
    exec.mockResolvedValueOnce({
      stdout: JSON.stringify({
        id: "native",
        working_dir: root,
        provider_name: "claude-code",
        conversation: [{ role: "assistant", content: [{ type: "text", text: "remembered" }] }],
      }),
      stderr: "",
      exitCode: 0,
    });
    exec.mockResolvedValueOnce({
      stdout: JSON.stringify({
        metadata: { status: "completed" },
        messages: [{ role: "assistant", content: [{ type: "text", text: "continued" }] }],
      }),
      stderr: "",
      exitCode: 0,
    });
    expect(
      await gooseAdapter.execute({ ...request, action: "resume", nativeId: "native" }, context),
    ).toMatchObject({ nativeId: "native", text: "continued" });
    expect(exec.mock.calls[1]![0].args).toContain("--system");
    expect(exec.mock.calls[1]![0].args.join(" ")).toContain("remembered");
  });
  it("bounds restored native context and excludes private provider metadata messages", () => {
    const restored = gooseRestartContext({
      conversation: [
        { content: "x".repeat(50000) },
        { content: "private", metadata: { userVisible: false } },
        { content: "recent" },
      ],
    });
    expect(restored).toContain("recent");
    expect(restored).not.toContain("private");
    expect(Buffer.byteLength(restored)).toBeLessThan(34000);
  });
  it("submits original OpenRig queue work with a stable native ID and literal body", async () => {
    exec.mockImplementation(async (command) => {
      expect(await readFile(command.args[command.args.indexOf("--body-file") + 1]!, "utf8")).toBe(
        request.input,
      );
      return {
        stdout: JSON.stringify({
          qitemId: command.args[command.args.indexOf("--id") + 1],
          destinationSession: "worker@rig",
          state: "pending",
        }),
        stderr: "",
        exitCode: 0,
      };
    });
    const a = await openrigAdapter.execute(
      { ...request, action: "submit-work", nativeId: "worker@rig" },
      context,
    );
    const b = await openrigAdapter.execute(
      { ...request, action: "submit-work", nativeId: "worker@rig" },
      context,
    );
    expect(a.state).toBe("submitted");
    expect(a.nativeId).toBe(b.nativeId);
    expect(exec.mock.calls[0]![0].args).toContain("--source");
  });
  it("reads the native queue outcome with its agent-authored evidence", async () => {
    exec.mockResolvedValueOnce({
      stdout: JSON.stringify({ qitemId: "owned", state: "done" }),
      stderr: "",
      exitCode: 0,
    });
    exec.mockResolvedValueOnce({
      stdout: JSON.stringify([
        { qitemId: "owned", transitionNote: "native reply", actorSession: "worker@rig" },
      ]),
      stderr: "",
      exitCode: 0,
    });
    const result = await openrigAdapter.execute(
      { ...request, action: "read-work", nativeId: "owned" },
      context,
    );
    expect(JSON.parse(result.text).transitions[0].transitionNote).toBe("native reply");
    expect(exec.mock.calls[1]![0].args).toEqual(["queue", "transitions", "owned", "--json"]);
  });
  it("rejects malformed OpenRig success responses", async () => {
    exec.mockResolvedValue({ stdout: "{}", stderr: "", exitCode: 0 });
    await expect(
      openrigAdapter.execute(
        { ...request, action: "submit-work", nativeId: "worker@rig" },
        context,
      ),
    ).rejects.toThrow("acknowledge");
  });
  it("requires explicit original superharness unrestricted mode before executing", async () => {
    await expect(superharnessAdapter.execute(request, context)).rejects.toThrow(
      "bypassPermissions",
    );
    expect(exec).not.toHaveBeenCalled();
  });
  it("uses native task context literally and never installs global hooks", async () => {
    await superharnessAdapter.execute(
      { ...request, action: "task-create", parameters: { title: "title", owner: "claude-code" } },
      context,
    );
    expect(exec.mock.calls[0]![0].args).toContain(request.input);
    await superharnessAdapter.execute({ ...request, action: "init" }, context);
    expect(exec.mock.calls[1]![0].args).toEqual(["init", "--skip-hooks"]);
  });
  it("keeps native CLI delegation permissions and bounds the configured deadline", async () => {
    expect(
      await superharnessAdapter.execute(
        {
          ...request,
          action: "delegate",
          nativeId: "owned-task",
          parameters: {
            owner: "claude-code",
            mode: "direct",
            timeoutSeconds: "300",
            permissionMode: "bypassPermissions",
          },
        },
        context,
      ),
    ).toMatchObject({ state: "submitted", nativeId: "owned-task" });
    const command = exec.mock.calls[0]![0];
    expect(command.args).toContain("--no-orchestrate");
    expect(command.args).toContain("cli");
    expect(command.args).not.toContain("--yolo");
    expect(command.env).toMatchObject({ SUPERHARNESS_CONFIRM_NON_INTERACTIVE: "YES" });
    expect(command.timeoutMs).toBe(310000);
    await expect(
      superharnessAdapter.execute(
        {
          ...request,
          action: "dispatch",
          parameters: { timeoutSeconds: "3600", permissionMode: "bypassPermissions" },
        },
        context,
      ),
    ).rejects.toThrow("Deadline");
  });
  it("dispatches the original queue without a PTY and with a workflow-sized deadline", async () => {
    await superharnessAdapter.execute(
      { ...request, action: "dispatch", parameters: { permissionMode: "bypassPermissions" } },
      context,
    );
    const command = exec.mock.calls[0]![0];
    expect(command.args).toContain("1800");
    expect(command.timeoutMs).toBe(1810000);
    expect(command.env).toMatchObject({ SUPERHARNESS_NO_PTY_WRAP: "1" });
    await superharnessAdapter.execute({ ...request, action: "status" }, context);
    expect(exec.mock.calls[1]![0].args).toContain("--include-subtasks");
  });
  async function squadFixture(): Promise<ToolActionRequest> {
    const worktree = path.join(root, "worktree");
    await mkdir(worktree);
    const stateFile = path.join(root, "state.json");
    await writeFile(
      stateFile,
      JSON.stringify({
        instances: [
          {
            title: "owned",
            path: root,
            program: "claude",
            worktree: { repo_path: root, worktree_path: worktree },
          },
        ],
      }),
    );
    exec.mockImplementation(async (command: ToolCommand) => {
      let stdout = "output";
      if (command.args[0] === "display-message") stdout = `%4\tclaude\t0\t${worktree}`;
      else if (command.args[0] === "capture-pane")
        stdout = "● reply\n────────\n❯ \n────────\n  auto mode on";
      return { stdout, stderr: "", exitCode: 0 };
    });
    return { ...request, nativeId: "claudesquad_owned", parameters: { stateFile } };
  }
  it("only reads and sends to an original Squad instance within the selected repository", async () => {
    const owned = await squadFixture();
    expect(await squadAdapter.execute({ ...owned, action: "send" }, context)).toMatchObject({
      state: "submitted",
      nativeId: owned.nativeId,
    });
    expect(exec.mock.calls.map(([command]) => command.args[0])).toEqual([
      "display-message",
      "capture-pane",
      "load-buffer",
      "paste-buffer",
      "send-keys",
    ]);
    expect(exec.mock.calls[3]![0].args).toContain("-p");
    exec.mockClear();
    await expect(
      squadAdapter.execute({ ...owned, action: "send", nativeId: "claudesquad_other" }, context),
    ).rejects.toThrow("unique original");
    expect(exec).not.toHaveBeenCalled();
  });
  it("rejects control bytes instead of injecting keys into a native agent", async () => {
    const owned = await squadFixture();
    await expect(
      squadAdapter.execute({ ...owned, action: "send", input: "hello\u001b[2J" }, context),
    ).rejects.toThrow("control characters");
    expect(exec).toHaveBeenCalledTimes(2);
  });
});
