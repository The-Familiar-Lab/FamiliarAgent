import path from "node:path";
import { lstat } from "node:fs/promises";
import type { ToolActionAdapter } from "../tool-actions/contracts.js";
import { inputFile, nativeId, optionalFlag, readBounded, runNative } from "./common.js";

export async function privateEnvironmentFile(filename: string): Promise<string> {
  if (!path.isAbsolute(filename) || filename.includes("\0"))
    throw new Error("Choose an absolute private API environment file path");
  const info = await lstat(filename).catch(() => null);
  if (
    !info ||
    !info.isFile() ||
    info.size > 64 * 1024 ||
    (info.mode & 0o077) !== 0 ||
    (process.getuid && info.uid !== process.getuid())
  )
    throw new Error(
      "The API environment file must be a user-owned regular file no larger than 64 KiB with permissions 0600",
    );
  return filename;
}

/** Aider logs errors as blockquotes and can exit zero after authentication failure. */
export function aiderReply(history: string, input: string): string {
  const prompt =
    input
      .replaceAll(/\r\n?/gu, "\n")
      .replace(/\n$/u, "")
      .split("\n")
      .map((line) => `#### ${line}`)
      .join("  \n")
      .trimEnd() + "  \n";
  const position = history.indexOf(prompt);
  if (position < 0) throw new Error("Aider did not persist the requested input");
  const response = history.slice(position + prompt.length).trim();
  if (!response.split(/\r?\n/u).some((line) => line.trim() && !line.startsWith("> ")))
    throw new Error(
      "Aider produced no assistant result. Check its native provider authentication and execution output.",
    );
  return response;
}
export const aiderAdapter: ToolActionAdapter = {
  id: "aider",
  actions: [
    {
      id: "run",
      label: "Run Aider",
      description:
        "Run Aider's native one-shot editor and retain its chat history. Interactive confirmations are declined unless explicitly allowed below.",
      input: true,
      inputMode: "prompt" as const,
      parameters: [
        { key: "model", label: "Model" },
        {
          key: "envFile",
          label: "Private API environment file",
          description:
            "Optional absolute path to a private .env file on this server (0600). Only its path is saved; Aider loads the credentials. Use Add API key in setup to prepare it.",
        },
        {
          key: "confirmations",
          label: "Native confirmations",
          description:
            "deny (default) declines interactive requests; allow uses Aider's original --yes-always option.",
        },
      ],
    },
    {
      id: "read-history",
      label: "Read Aider history",
      description: "Read an existing Aider Markdown chat history file.",
      nativeId: true,
      mutates: false,
    },
  ],
  async execute(request, context) {
    if (request.action === "read-history") {
      const filename = nativeId(request);
      if (!path.isAbsolute(filename) || !filename.endsWith(".md"))
        throw new Error("Select an absolute Aider Markdown history path");
      return { state: "completed", text: await readBounded(filename), nativeId: filename };
    }
    if (request.action !== "run") throw new Error("Unsupported Aider action");
    const envFile = request.parameters.envFile
      ? await privateEnvironmentFile(request.parameters.envFile)
      : undefined;
    const input = await inputFile(context, request.input);
    const history = path.join(context.runDirectory, "aider.chat.history.md");
    const args = [
      "--message-file",
      input,
      "--chat-history-file",
      history,
      "--input-history-file",
      path.join(context.runDirectory, "aider.input.history"),
      "--no-stream",
      "--no-check-update",
      "--no-show-release-notes",
      "--no-auto-commits",
    ];
    optionalFlag(args, "--model", request.parameters.model);
    optionalFlag(args, "--env-file", envFile);
    const confirmations = request.parameters.confirmations || "deny";
    if (!["deny", "allow"].includes(confirmations))
      throw new Error("Choose deny or allow for native confirmations");
    if (confirmations === "allow") args.push("--yes-always");
    await runNative(context, {
      command: "aider",
      args,
      cwd: request.cwd,
      stdin: "n\n".repeat(64),
      env: { BROWSER: "false", AIDER_YES_ALWAYS: String(confirmations === "allow") },
    });
    return {
      state: "completed",
      text: aiderReply(await readBounded(history), request.input),
      nativeId: history,
      artifacts: [{ path: history, label: "Aider chat history" }],
    };
  },
};
