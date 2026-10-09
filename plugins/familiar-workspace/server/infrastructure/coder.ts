import path from "node:path";
import type { ToolActionAdapter } from "../tool-actions/contracts.js";
import { binaryParameter, cli, inputText, jsonOutput, nativeId, parameter } from "./common.js";
const common = [
  binaryParameter,
  {
    key: "configDirectory",
    label: "Coder profile directory",
    description:
      "Optional absolute directory already signed in with coder login; otherwise uses Coder defaults.",
  },
];
export const coderAdapter: ToolActionAdapter = {
  id: "coder",
  actions: [
    {
      id: "list",
      mutates: false,
      label: "List workspaces",
      description:
        "Read workspaces from the original Coder control plane. First sign in with coder login (Ask setup can open native setup).",
    },
    {
      id: "templates",
      mutates: false,
      label: "List templates",
      description: "Read the original provisioner templates.",
    },
    {
      id: "show",
      mutates: false,
      label: "Workspace details",
      nativeId: true,
      description: "Read native workspace resources and agent state.",
    },
    {
      id: "create",
      label: "Create workspace",
      nativeId: true,
      description: "Let Coder provision a workspace from an existing template.",
      parameters: [
        { key: "template", label: "Template name", required: true },
        {
          key: "parameterFile",
          label: "Native parameter file (optional)",
          description: "Path to Coder rich-parameter YAML; secrets stay on this server.",
        },
      ],
    },
    {
      id: "start",
      label: "Start workspace",
      nativeId: true,
      description: "Start through the native Coder provisioner.",
    },
    {
      id: "stop",
      label: "Stop workspace",
      nativeId: true,
      description: "Stop through the native Coder provisioner.",
    },
    {
      id: "exec",
      label: "Run in workspace",
      nativeId: true,
      input: true,
      inputMode: "command" as const,
      description: "Run an explicit shell command through Coder SSH and its workspace agent.",
    },
  ].map((action) =>
    Object.assign(action, { parameters: [...common, ...(action.parameters ?? [])] }),
  ),
  async execute(request, context) {
    const args: string[] = [];
    const config = parameter(request, "configDirectory", false);
    if (config) {
      if (!path.isAbsolute(config)) throw new Error("Coder profile directory must be absolute");
      args.push("--global-config", config);
    }
    let id: string | undefined;
    if (request.action === "list") args.push("list", "--output", "json");
    else if (request.action === "templates") args.push("templates", "list", "--output", "json");
    else {
      id = nativeId(request);
      if (request.action === "show") args.push("show", id);
      else if (request.action === "create") {
        args.push("create", id, "--template", parameter(request, "template"), "--yes");
        const file = parameter(request, "parameterFile", false);
        if (file) args.push("--rich-parameter-file", path.resolve(request.cwd, file));
      } else if (request.action === "start" || request.action === "stop")
        args.push(request.action, id, "--yes");
      else if (request.action === "exec") args.push("ssh", id, "--", inputText(request));
      else throw new Error("Unknown Coder action");
    }
    const text = await cli(request, context, "coder", args);
    return {
      state: "completed",
      text: ["list", "templates"].includes(request.action) ? jsonOutput(text) : text,
      ...(id ? { nativeId: id } : {}),
    };
  },
};
