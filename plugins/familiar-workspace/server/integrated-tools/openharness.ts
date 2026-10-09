import type { ToolActionAdapter } from "../tool-actions/contracts.js";
import { cli, integer, parameter, record } from "./common.js";

const command = {
  key: "command",
  label: "Harness CLI",
  description: "Installed OpenHarness CLI. Launches require its original signed-in daemon.",
};

export const openHarnessAdapter: ToolActionAdapter = {
  id: "openharness",
  actions: [
    {
      id: "status",
      mutates: false,
      label: "Read Harness sign-in",
      description: "Read native authentication status without opening a login flow.",
      parameters: [command],
    },
    {
      id: "search",
      mutates: false,
      label: "Search Harness history",
      description: "Search the native local conversation index.",
      input: true,
      inputMode: "data",
      parameters: [command, { key: "limit", label: "Maximum results" }],
    },
    {
      id: "run",
      label: "Start with Harness",
      description:
        "Ask the original daemon to create an agent with this task. Harness retains tmux, model and orchestration ownership.",
      input: true,
      inputMode: "prompt",
      parameters: [command, { key: "agent", label: "Native agent name", required: true }],
    },
  ],
  async execute(request, context) {
    if (request.action === "status")
      return cli(request, context, "harness", ["auth", "status", "--json"]);
    if (request.action === "search")
      return cli(request, context, "harness", [
        "search",
        request.input,
        `--limit=${integer(request.parameters.limit, 30, 100)}`,
        "--json",
      ]);
    if (request.action === "run") {
      const response = await cli(
        request,
        context,
        "harness",
        [
          "new",
          parameter(request, "agent"),
          request.cwd,
          "--mode",
          "ask",
          "--json",
          "--",
          request.input,
        ],
        "submitted",
      );
      const output = record(JSON.parse(response.text));
      const agent = output.agent && typeof output.agent === "object" ? record(output.agent) : {};
      if (output.ok !== true || typeof agent.id !== "string" || !agent.id)
        throw new Error(
          "OpenHarness did not acknowledge a new native agent. Check native sign-in and daemon status before retrying.",
        );
      return { ...response, nativeId: agent.id };
    }
    throw new Error("Unknown Harness action.");
  },
};
