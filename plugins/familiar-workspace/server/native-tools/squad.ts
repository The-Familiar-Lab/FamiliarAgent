import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ToolActionAdapter, ToolActionRequest } from "../tool-actions/contracts.js";
import { inputFile, nativeId, objectJson, readBounded, runNative } from "./common.js";

interface SquadInstance {
  title: string;
  path: string;
  program: string;
  worktree: { repo_path: string; worktree_path: string };
  nativeId: string;
}
export function isClaudeComposerIdle(capture: string): boolean {
  const lines = capture.trimEnd().split(/\r?\n/u).slice(-12);
  if (
    lines.some(
      (line) =>
        /(?:esc|ctrl\+c) to (?:interrupt|stop)/iu.test(line) ||
        /^[✢✳✶✻✽·].*(?:…|\.\.\.)/u.test(line),
    )
  )
    return false;
  const index = lines.findLastIndex((line) => /^❯\s*$/u.test(line));
  if (index < 0) return false;
  const following = lines.slice(index + 1).filter((line) => line.trim());
  return (
    following.length > 0 &&
    /^[─━]{3,}/u.test(following[0]!) &&
    !following.some((line) => /(?:confirm|proceed|cancel|Esc to|Press Enter)/iu.test(line))
  );
}
async function instances(request: ToolActionRequest): Promise<SquadInstance[]> {
  const filename =
    request.parameters.stateFile || path.join(os.homedir(), ".claude-squad", "state.json");
  if (!path.isAbsolute(filename)) throw new Error("Claude Squad state file must be absolute");
  const value = objectJson(await readBounded(filename));
  if (!Array.isArray(value.instances)) throw new Error("Invalid original Claude Squad state");
  const cwd = await realpath(request.cwd);
  const result: SquadInstance[] = [];
  for (const row of value.instances) {
    if (
      !row ||
      typeof row.title !== "string" ||
      typeof row.path !== "string" ||
      typeof row.program !== "string" ||
      typeof row.worktree?.repo_path !== "string" ||
      typeof row.worktree?.worktree_path !== "string"
    )
      throw new Error("Unsupported Claude Squad instance format");
    let belongs = false;
    for (const candidate of [row.path, row.worktree.repo_path, row.worktree.worktree_path]) {
      try {
        if ((await realpath(candidate)) === cwd) belongs = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    if (belongs)
      result.push({
        ...row,
        nativeId: `claudesquad_${row.title.replaceAll(/\s/gu, "").replaceAll(".", "_")}`,
      });
  }
  return result;
}
export const squadAdapter: ToolActionAdapter = {
  id: "claude-squad",
  actions: [
    {
      id: "list",
      label: "List Claude Squad workspaces",
      description:
        "Read original Squad instances belonging to this repository. Create new instances in its native TUI.",
      mutates: false,
    },
    {
      id: "read",
      label: "Read Claude Squad output",
      description: "Capture the original Squad agent pane; no session is copied.",
      nativeId: true,
      mutates: false,
    },
    {
      id: "send",
      label: "Send to Claude Squad agent",
      description:
        "Paste input into the original live agent pane and press Enter. Delivery is not task completion.",
      nativeId: true,
      input: true,
      inputMode: "prompt" as const,
    },
  ].map((action) =>
    Object.assign(action, {
      parameters: [
        {
          key: "stateFile",
          label: "Original Squad state file",
          description:
            "Optional absolute .claude-squad/state.json path; defaults to this user's native state.",
        },
      ],
    }),
  ),
  async execute(request, context) {
    const rows = await instances(request);
    if (request.action === "list")
      return {
        state: "completed",
        text: JSON.stringify(
          rows.map(({ title, path: folder, nativeId: id, program, worktree }) => ({
            title,
            folder,
            nativeId: id,
            program,
            worktree: worktree.worktree_path,
          })),
          null,
          2,
        ),
      };
    if (!["read", "send"].includes(request.action))
      throw new Error("Unsupported Claude Squad action");
    const id = nativeId(request);
    const matches = rows.filter((row) => row.nativeId === id);
    if (matches.length !== 1)
      throw new Error("Select a unique original Claude Squad instance in this repository");
    const pane = (
      await runNative(context, {
        command: "tmux",
        args: [
          "display-message",
          "-p",
          "-t",
          `=${id}:0.0`,
          "#{pane_id}\t#{pane_current_command}\t#{pane_dead}\t#{pane_current_path}",
        ],
        cwd: request.cwd,
      })
    )
      .trim()
      .split("\t");
    if (
      !/^%\d+$/u.test(pane[0] ?? "") ||
      (await realpath(pane[3] ?? "")) !== (await realpath(matches[0]!.worktree.worktree_path))
    )
      throw new Error("The original Squad pane is missing or no longer belongs to its worktree");
    const target = pane[0]!;
    if (request.action === "read")
      return {
        state: "completed",
        text: await runNative(context, {
          command: "tmux",
          args: ["capture-pane", "-p", "-J", "-S", "-200", "-t", target],
          cwd: request.cwd,
        }),
        nativeId: id,
      };
    if (pane[2] !== "0" || pane[1] !== "claude")
      throw new Error(
        "Automatic Squad input currently requires a verified Claude composer. Open its original terminal for other agents.",
      );
    const capture = await runNative(context, {
      command: "tmux",
      args: ["capture-pane", "-p", "-J", "-t", target],
      cwd: request.cwd,
    });
    if (!isClaudeComposerIdle(capture))
      throw new Error(
        "The native Squad agent is busy, has a dialog open, or its composer is not recognized. Continue in its original UI before sending input.",
      );
    if (
      [...request.input].some((character) => {
        const code = character.charCodeAt(0);
        return (code < 32 && code !== 9 && code !== 10) || code === 127;
      })
    )
      throw new Error("Terminal control characters are not allowed in agent input");
    const buffer = `familiar-${createHash("sha256").update(context.runDirectory).digest("hex").slice(0, 24)}`;
    await runNative(context, {
      command: "tmux",
      args: ["load-buffer", "-b", buffer, await inputFile(context, request.input)],
      cwd: request.cwd,
    });
    await runNative(context, {
      command: "tmux",
      args: ["paste-buffer", "-p", "-d", "-b", buffer, "-t", target],
      cwd: request.cwd,
    });
    await runNative(context, {
      command: "tmux",
      args: ["send-keys", "-t", target, "Enter"],
      cwd: request.cwd,
    });
    return {
      state: "submitted",
      text: "Input delivered to the original Claude Squad agent pane. Read its output to inspect progress and results.",
      nativeId: id,
    };
  },
};
