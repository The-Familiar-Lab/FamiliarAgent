import { realpath } from "node:fs/promises";
import path from "node:path";
import type {
  ToolActionAdapter,
  ToolActionContext,
  ToolActionRequest,
} from "../tool-actions/contracts.js";
import { nativeId, optionalFlag, readBounded, required, runNative } from "./common.js";

async function verifySdk(
  executable: string,
  cwd: string,
  context: ToolActionContext,
): Promise<void> {
  // Upstream's SDK-less fallback drops the prompt. Fail before dispatch instead.
  const script = await readBounded(await realpath(executable));
  const interpreter = /^#!(\/[^\r\n]+)\r?\n/u.exec(script)?.[1];
  if (!interpreter || interpreter.includes(" "))
    throw new Error(
      "Cannot verify the superharness Python environment. Install the native Python entrypoint with claude-agent-sdk.",
    );
  await runNative(context, {
    command: interpreter,
    args: [
      "-c",
      "from superharness.engine.sdk_runner import sdk_available; import sys; sys.exit(0 if sdk_available() else 1)",
    ],
    cwd,
  });
}

function executionDeadline(request: ToolActionRequest): number {
  if (
    ["run", "dispatch", "delegate"].includes(request.action) &&
    request.parameters.permissionMode !== "bypassPermissions"
  )
    throw new Error(
      "The original unattended superharness runner requires an explicit bypassPermissions selection",
    );
  const seconds = Number(request.parameters.timeoutSeconds || "90");
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 3590)
    throw new Error("Deadline must be 1–3590 seconds");
  return seconds;
}

async function launchEnvironment(
  executable: string,
  context: ToolActionContext,
): Promise<Record<string, string>> {
  const shared = await context.nativeContext?.("superharness");
  const searchPath = shared?.env.PATH || process.env.PATH || "";
  return {
    ...shared?.env,
    PATH: [searchPath, path.dirname(executable)].filter(Boolean).join(path.delimiter),
  };
}

const permissionParameter = {
  key: "permissionMode",
  label: "Native unattended permission mode",
  required: true,
  description:
    "Type bypassPermissions to allow the original unattended SDK/Claude launcher, which skips its interactive permissions.",
};

export const superharnessAdapter: ToolActionAdapter = {
  id: "superharness",
  actions: [
    {
      id: "init",
      label: "Initialize superharness project",
      description: "Run native init without global hooks or installing a background watcher.",
    },
    {
      id: "task-create",
      label: "Create superharness task",
      description: "Create an original contract task with this input as operator context.",
      input: true,
      inputMode: "prompt" as const,
      parameters: [
        { key: "title", label: "Task title", required: true },
        { key: "owner", label: "Native owner", required: true },
      ],
    },
    {
      id: "enqueue",
      label: "Queue superharness task",
      description: "Put an existing contract task into the native agent inbox.",
      nativeId: true,
      parameters: [{ key: "owner", label: "Native owner", required: true }],
    },
    {
      id: "dispatch",
      label: "Dispatch next native task",
      description:
        "Let the native dispatcher choose its next queued task using its configured policy. SDK/Claude unattended execution bypasses permissions. Queue ACK is not task completion.",
      parameters: [
        permissionParameter,
        { key: "owner", label: "Native owner filter" },
        {
          key: "timeoutSeconds",
          label: "Native deadline (seconds)",
          description: "Default 90; choose 1–3590 for longer native orchestration.",
        },
      ],
    },
    {
      id: "delegate",
      label: "Delegate task through native CLI",
      description:
        "Run an existing native contract task unattended through the original CLI delegate. Claude/Codex children inherit shared MCP. The original unattended Claude launcher bypasses permissions.",
      nativeId: true,
      parameters: [
        permissionParameter,
        { key: "owner", label: "Native owner", required: true },
        {
          key: "mode",
          label: "Orchestration",
          description:
            "native (default) preserves the original orchestration; direct uses its documented --no-orchestrate path.",
        },
        { key: "model", label: "Model" },
        {
          key: "timeoutSeconds",
          label: "Deadline (seconds)",
          description: "Default 90; choose 1–3590.",
        },
      ],
    },
    {
      id: "status",
      label: "Read superharness contract",
      description: "Read native task status and delegation suggestions.",
      mutates: false,
    },
    {
      id: "run",
      label: "Run native superharness SDK",
      description:
        "Original SDK runner uses bypassPermissions and may fork the latest project conversation. Selected input is connected; this SDK does not expose per-launch shared MCP. Use the native CLI delegate for MCP.",
      input: true,
      inputMode: "prompt" as const,
      parameters: [
        permissionParameter,
        { key: "model", label: "Model" },
        {
          key: "timeoutSeconds",
          label: "Native deadline (seconds)",
          description: "Default 90; choose 1–3590.",
        },
      ],
    },
  ],
  async execute(request, context) {
    const seconds = executionDeadline(request);
    const executable = await context.resolveCommand("superharness");
    let args: string[];
    let id: string | undefined;
    if (request.action === "init") args = ["init", "--skip-hooks"];
    else if (request.action === "status") args = ["contract", "--project", request.cwd];
    else if (request.action === "task-create") {
      id = `familiar-${path.basename(context.runDirectory).replaceAll(/[^A-Za-z0-9_-]/gu, "-")}`;
      args = [
        "task",
        "create",
        "--project",
        request.cwd,
        "--id",
        id,
        "--title",
        required(request.parameters.title, "Title"),
        "--owner",
        required(request.parameters.owner, "Owner"),
        "--context",
        required(request.input, "Input"),
      ];
    } else if (request.action === "enqueue") {
      id = nativeId(request);
      args = [
        "enqueue",
        "--project",
        request.cwd,
        "--task",
        id,
        "--to",
        required(request.parameters.owner, "Owner"),
        "--json",
      ];
    } else if (request.action === "dispatch") {
      args = [
        "dispatch",
        "--project",
        request.cwd,
        "--non-interactive",
        "--launcher-timeout",
        String(seconds),
      ];
      optionalFlag(args, "--to", request.parameters.owner);
    } else if (request.action === "delegate") {
      id = nativeId(request);
      args = [
        "delegate",
        "--project",
        request.cwd,
        "--task",
        id,
        "--to",
        required(request.parameters.owner, "Owner"),
        "--via",
        "cli",
        "--non-interactive",
      ];
      if (request.parameters.mode === "direct") args.push("--no-orchestrate");
      else if (request.parameters.mode && request.parameters.mode !== "native")
        throw new Error("Choose native or direct orchestration");
      optionalFlag(args, "--model", request.parameters.model);
    } else if (request.action === "run") {
      await verifySdk(executable, request.cwd, context);
      args = ["run", "--project", request.cwd, "--timeout", String(seconds)];
      optionalFlag(args, "--model", request.parameters.model);
      args.push("--", required(request.input, "Input"));
    } else throw new Error("Unsupported superharness action");
    const env = await launchEnvironment(executable, context);
    if (request.action === "delegate") env.SUPERHARNESS_CONFIRM_NON_INTERACTIVE = "YES";
    const output = await runNative(context, {
      command: executable,
      args,
      cwd: request.cwd,
      timeoutMs: (seconds + 10) * 1000,
      env,
    });
    if (!output.trim()) throw new Error("superharness returned no native result");
    return {
      state: ["enqueue", "dispatch", "delegate"].includes(request.action)
        ? "submitted"
        : "completed",
      text: output,
      nativeId: id,
    };
  },
};
