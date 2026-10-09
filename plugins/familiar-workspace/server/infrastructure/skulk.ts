import type { ToolActionAdapter } from "../tool-actions/contracts.js";
import { binaryParameter, cli, inputText, nativeId, parameter } from "./common.js";

export const skulkAdapter: ToolActionAdapter = {
  id: "skulk",
  actions: [
    {
      id: "doctor",
      mutates: false,
      label: "Check remote setup",
      description:
        "Run Skulk’s SSH, Git, tmux and harness checks. First use Ask setup to configure .skulk/config.toml in this project; existing SSH login is reused.",
    },
    {
      id: "list",
      mutates: false,
      label: "List agents",
      description: "Read Skulk's actual remote agent inventory.",
    },
    {
      id: "new",
      label: "Create isolated agent",
      nativeId: true,
      description:
        "Skulk creates its native branch, worktree and tmux agent. Uses the permissions policy already configured in Skulk.",
      parameters: [{ key: "model", label: "Native model (optional)" }],
    },
    {
      id: "status",
      mutates: false,
      label: "Agent status",
      nativeId: true,
      description: "Read native status and worktree details.",
    },
    {
      id: "logs",
      mutates: false,
      label: "Read terminal output",
      nativeId: true,
      description: "Capture up to 200 native terminal lines.",
    },
    {
      id: "diff",
      mutates: false,
      label: "Review changes",
      nativeId: true,
      description: "Read the native Git diff without changing it.",
    },
    {
      id: "send",
      label: "Send input",
      nativeId: true,
      input: true,
      inputMode: "command" as const,
      description:
        "Send explicit text to the original tmux session. Check its running program first; this is not an automatic result-input destination.",
    },
    {
      id: "archive",
      label: "Archive agent",
      nativeId: true,
      description: "Stop this native tmux agent while preserving its worktree and branch.",
    },
  ].map((action) =>
    Object.assign(action, { parameters: [binaryParameter, ...(action.parameters ?? [])] }),
  ),
  async execute(request, context) {
    if (!this.actions.some((action) => action.id === request.action))
      throw new Error("Unknown Skulk action");
    const args = ["--no-color", "--json", request.action];
    const needsName = !["doctor", "list"].includes(request.action);
    const id = needsName ? nativeId(request) : undefined;
    if (id && !/^[a-z0-9][a-z0-9-]*$/u.test(id))
      throw new Error("Skulk names use lowercase letters, digits and hyphens");
    if (id) args.push(id);
    if (request.action === "logs") args.push("--lines", "200");
    if (request.action === "send") args.push("--", inputText(request));
    if (request.action === "new") {
      const model = parameter(request, "model", false);
      if (model) {
        if (!/^[A-Za-z0-9._/-]+$/u.test(model)) throw new Error("Invalid native model");
        args.push("--model", model);
      }
    }
    const text = await cli(request, context, "skulk", args);
    return {
      state: request.action === "send" ? "submitted" : "completed",
      text,
      ...(id ? { nativeId: id } : {}),
    };
  },
};
