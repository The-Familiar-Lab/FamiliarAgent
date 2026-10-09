import type { ToolActionAdapter } from "../tool-actions/contracts.js";
import { cli, integer, nativeId, record } from "./common.js";

const command = {
  key: "command",
  label: "Orca CLI",
  description: "Installed orca executable. The original Orca runtime must be running.",
};

export const orcaAdapter: ToolActionAdapter = {
  id: "orca",
  actions: [
    {
      id: "create",
      label: "Create Orca terminal",
      description:
        "Create a native terminal in a project already registered in Orca. The original runtime owns its process and state.",
      parameters: [
        command,
        { key: "terminalCommand", label: "Original startup command (optional)" },
      ],
    },
    {
      id: "list",
      mutates: false,
      label: "List Orca terminals",
      description: "Read native terminal IDs in this project.",
      parameters: [command],
    },
    {
      id: "read",
      mutates: false,
      label: "Read Orca output",
      description:
        "Read bounded native terminal output; this is not a structured conversation transcript.",
      nativeId: true,
      parameters: [
        command,
        { key: "cursor", label: "Output cursor" },
        { key: "limit", label: "Maximum lines" },
      ],
    },
    {
      id: "send",
      label: "Send input to Orca",
      description:
        "Submit once through Orca's native terminal input API. An input receipt is not task completion.",
      input: true,
      inputMode: "command",
      nativeId: true,
      parameters: [command],
    },
  ],
  async execute(request, context) {
    const scope = ["--worktree", `path:${request.cwd}`];
    if (request.action === "list")
      return cli(request, context, "orca", [
        "terminal",
        "list",
        ...scope,
        "--limit",
        "100",
        "--json",
      ]);
    if (request.action === "create") {
      const created = await cli(request, context, "orca", [
        "terminal",
        "create",
        ...scope,
        ...(request.parameters.terminalCommand
          ? ["--command", request.parameters.terminalCommand]
          : []),
        "--json",
      ]);
      const handle = record(record(record(JSON.parse(created.text)).result).terminal).handle;
      if (typeof handle !== "string")
        throw new Error("Orca did not return the created terminal handle.");
      return { ...created, nativeId: handle };
    }
    const id = nativeId(request);
    if (request.action === "read") {
      const cursor = request.parameters.cursor;
      if (cursor && !/^\d+$/.test(cursor))
        throw new Error("The output cursor must be a nonnegative integer.");
      return cli(request, context, "orca", [
        "terminal",
        "read",
        "--terminal",
        id,
        "--limit",
        String(integer(request.parameters.limit, 200, 2000)),
        ...(cursor ? ["--cursor", cursor] : []),
        "--json",
      ]);
    }
    if (request.action === "send")
      return cli(
        request,
        context,
        "orca",
        [
          "terminal",
          "send",
          "--terminal",
          id,
          "--text",
          request.input,
          "--enter",
          "--wait-submit",
          "5",
          "--json",
        ],
        "submitted",
      );
    throw new Error("Unknown Orca action.");
  },
};
