import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { ToolActionAdapter } from "../tool-actions/contracts.js";
import { integer, nativeId, parameter, record, result } from "./common.js";
import { CODEY_RUNNER } from "./codey-runner.js";

const configuration = [
  { key: "moduleRoot", label: "Built Codey checkout", required: true },
  {
    key: "dataRoot",
    label: "Dedicated Codey data folder",
    required: true,
    description:
      "An empty folder or one previously created by this integration. Existing desktop data is never opened concurrently.",
  },
  { key: "nodeCommand", label: "Node.js 24.12+ executable", required: true },
];
const marker = ".familiar-codey-profile";

async function prepareProfile(root: string) {
  if (!isAbsolute(root)) throw new Error("Select an absolute dedicated Codey data folder.");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const files = await readdir(root);
  if (!files.includes(marker)) {
    if (files.length)
      throw new Error(
        "Codey requires an empty dedicated data folder; the desktop application's existing profile is not modified.",
      );
    await writeFile(join(root, marker), "1\n", { flag: "wx", mode: 0o600 });
    await writeFile(
      join(root, "gateway.json"),
      JSON.stringify({
        gateway: { port: 0, skipPermissions: false },
        channels: {},
        agents: {},
        models: [],
        apiKeys: [],
        fallback: { enabled: false, order: [{ agent: "claude-code" }] },
        dev: { logLevel: "error" },
        memory: { enabled: false },
      }),
      { flag: "wx", mode: 0o600 },
    );
  } else if ((await readFile(join(root, marker), "utf8")) !== "1\n")
    throw new Error("Unsupported Codey integration profile.");
}

export const codeyAdapter: ToolActionAdapter = {
  id: "codey",
  actions: [
    {
      id: "list",
      label: "List Codey conversations",
      description: "Read this dedicated native Codey gateway's original chat catalog.",
      parameters: configuration,
    },
    {
      id: "read",
      label: "Read Codey conversation",
      description: "Read bounded recent messages from Codey's native ChatManager.",
      nativeId: true,
      parameters: [...configuration, { key: "limit", label: "Recent messages" }],
    },
    {
      id: "run",
      label: "Run with Codey",
      description:
        "Create a conversation using Codey's original gateway, workspace, context and agent methods.",
      input: true,
      inputMode: "prompt",
      parameters: [
        ...configuration,
        { key: "agent", label: "Native agent (claude-code/codex/opencode/pi)" },
        { key: "model", label: "Native model" },
      ],
    },
    {
      id: "send",
      label: "Continue Codey conversation",
      input: true,
      inputMode: "prompt",
      nativeId: true,
      description: "Continue an existing native chat in this dedicated Codey profile.",
      parameters: configuration,
    },
  ],
  async execute(request, context) {
    if (!["list", "read", "run", "send"].includes(request.action))
      throw new Error("Unknown Codey action.");
    const dataRoot = parameter(request, "dataRoot");
    const moduleRoot = parameter(request, "moduleRoot");
    if (!isAbsolute(moduleRoot)) throw new Error("Select an absolute built Codey checkout.");
    const agent = request.parameters.agent || "claude-code";
    if (!["claude-code", "codex", "opencode", "pi"].includes(agent))
      throw new Error("Select a native Codey agent.");
    if (["read", "send"].includes(request.action)) nativeId(request);
    await prepareProfile(dataRoot);
    const lock = join(dataRoot, ".familiar-active");
    try {
      await mkdir(lock);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        throw new Error("This Codey profile is busy. Wait for its current operation to finish.", {
          cause: error,
        });
      throw error;
    }
    try {
      const script = join(context.runDirectory, "codey-bridge.cjs");
      await writeFile(script, CODEY_RUNNER, { mode: 0o600 });
      const response = await context.exec({
        command: await context.resolveCommand(parameter(request, "nodeCommand")),
        args: [script],
        cwd: dataRoot,
        env: { CODEY_HOME: dataRoot, CO_MEMO_HOME: join(dataRoot, "memory") },
        stdin: JSON.stringify({
          moduleRoot,
          dataRoot,
          action: request.action,
          cwd: request.cwd,
          input: request.input,
          nativeId: request.nativeId,
          agent,
          model: request.parameters.model,
          limit: integer(request.parameters.limit, 30, 100),
        }),
        timeoutMs: 240000,
      });
      if (response.exitCode !== 0)
        throw new Error(`Codey exited with ${response.exitCode}: ${response.stderr}`);
      const line = response.stdout
        .split("\n")
        .findLast((entry) => entry.startsWith("FAMILIAR_CODEY_RESULT="));
      if (!line) throw new Error("The original Codey gateway did not return a result.");
      const output: unknown = JSON.parse(line.slice("FAMILIAR_CODEY_RESULT=".length));
      const id = Array.isArray(output) ? undefined : record(output).chatId;
      return result(output, "completed", typeof id === "string" ? id : request.nativeId);
    } finally {
      await rm(lock, { recursive: true });
    }
  },
};
