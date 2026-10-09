import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ToolActionAdapter, ToolActionRequest } from "../tool-actions/contracts.js";
import { nativeId, parameter, record, result } from "./common.js";

const command = { key: "command", label: "Pullboard executable" };
const boardActions = new Set(["init", "status", "list", "read", "add", "prompt", "snapshot"]);

function itemId(request: ToolActionRequest): string {
  const id = nativeId(request);
  if (!/^[1-9]\d*$/u.test(id) || !Number.isSafeInteger(Number(id)))
    throw new Error("Choose a positive native Pullboard item ID.");
  return id;
}

async function argumentsFor(request: ToolActionRequest, runDirectory: string) {
  switch (request.action) {
    case "init":
    case "status":
      return [request.action];
    case "list":
      return ["list", "--all"];
    case "read":
      return ["show", itemId(request), "--history"];
    case "prompt": {
      const role = parameter(request, "role");
      if (!["run", "decompose", "plan", "signoff", "review", "verify"].includes(role))
        throw new Error("Choose a documented Pullboard role.");
      return ["prompt", role];
    }
    case "snapshot":
      return ["view", "--export", join(runDirectory, "pullboard-view")];
    case "add": {
      const lane = parameter(request, "lane");
      const title = parameter(request, "title");
      if (lane.startsWith("-") || title.startsWith("-"))
        throw new Error("Pullboard lane and title cannot begin with a CLI option marker.");
      const brief = join(runDirectory, "pullboard-brief.txt");
      await writeFile(brief, request.input, { flag: "wx", mode: 0o600 });
      return [
        "add",
        lane,
        title,
        "--brief-file",
        brief,
        ...["criterion", "specs"].flatMap((key) =>
          request.parameters[key] ? [`--${key}=${request.parameters[key]}`] : [],
        ),
      ];
    }
    default:
      throw new Error("Unknown Pullboard action.");
  }
}

export const pullboardAdapter: ToolActionAdapter = {
  id: "pullboard",
  actions: [
    {
      id: "init",
      label: "Initialize project board",
      description:
        "Explicitly run original Pullboard init in this Git project. It adds its managed spec, doctrine, agent instructions and hooks while preserving unrelated files and hooks. It does not commit or start agents.",
      parameters: [command],
    },
    {
      id: "status",
      label: "Read board status",
      description: "Read the original project's agents, work and review queue.",
      mutates: false,
      parameters: [command],
    },
    {
      id: "list",
      label: "List work items",
      description: "Read open and closed native work items without claiming them.",
      mutates: false,
      parameters: [command],
    },
    {
      id: "read",
      label: "Read item and verification history",
      description: "Read the selected original item, frozen criterion and review notes.",
      nativeId: true,
      mutates: false,
      parameters: [command],
    },
    {
      id: "add",
      label: "Add work from this input",
      description:
        "Pass this input as a native work item's brief; the original CLI trims surrounding whitespace. Pullboard owns lanes, spec checks and subsequent coordination. Adding an item does not run or complete it.",
      input: true,
      inputMode: "prompt",
      parameters: [
        command,
        { key: "lane", label: "Existing lane", required: true },
        { key: "title", label: "Work item title", required: true },
        { key: "criterion", label: "Acceptance criterion" },
        { key: "specs", label: "Spec IDs (comma separated)" },
      ],
    },
    {
      id: "prompt",
      label: "Read original role guide",
      description: "Read Pullboard's original role instructions for use by another agent.",
      mutates: false,
      parameters: [command, { key: "role", label: "Role", required: true }],
    },
    {
      id: "snapshot",
      label: "Export original board view",
      description:
        "Export the original replayable, read-only HTML board and its data into this run's private artifacts. It contains no live service session key.",
      mutates: false,
      parameters: [command],
    },
  ],
  async execute(request, context) {
    if (!boardActions.has(request.action)) throw new Error("Unknown Pullboard action.");
    const args = await argumentsFor(request, context.runDirectory);
    const output = await context.exec({
      command: await context.resolveCommand(request.parameters.command || "pullboard"),
      args: [...args, "--json"],
      cwd: request.cwd,
      timeoutMs: 60_000,
      maxBytes: 65_536,
    });
    let document: Record<string, unknown>;
    try {
      document = record(JSON.parse(output.stdout));
    } catch {
      throw new Error(`Pullboard returned no versioned result (exit ${output.exitCode}).`);
    }
    if (output.exitCode !== 0 || document.error) {
      const error = document.error ? record(document.error) : {};
      throw new Error(
        `Pullboard refused the action: ${String(error.code ?? output.exitCode)}. ${String(error.message ?? "Check the original terminal.")} ${String(error.next ?? "")}`,
      );
    }
    if (document.version !== 1) throw new Error("Unsupported Pullboard response version.");
    if (request.action === "add") {
      const id = record(document.item).item_id;
      if (!Number.isSafeInteger(id) || Number(id) < 1)
        throw new Error("Pullboard did not return a created item ID.");
      return result(document, "submitted", String(id));
    }
    if (request.action === "snapshot")
      return {
        ...result(document),
        artifacts: [
          {
            path: join(context.runDirectory, "pullboard-view", "index.html"),
            label: "Pullboard snapshot",
          },
          { path: join(context.runDirectory, "pullboard-view"), label: "Complete snapshot folder" },
        ],
      };
    return result(document, "completed", request.action === "read" ? itemId(request) : undefined);
  },
};
