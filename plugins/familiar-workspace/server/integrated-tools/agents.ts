import { readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { ToolActionAdapter } from "../tool-actions/contracts.js";
import { parameter, record, result } from "./common.js";

const plugin = {
  key: "pluginPath",
  label: "Selected plugin folder",
  required: true,
  description:
    "One native plugin from the wshobson/agents checkout, for example plugins/python-development.",
};

export const agentsAdapter: ToolActionAdapter = {
  id: "agents",
  actions: [
    {
      id: "inspect",
      mutates: false,
      label: "Inspect native skill package",
      description:
        "Verify a selected native Claude plugin and list its original skills without copying or installing globally.",
      parameters: [plugin],
    },
    {
      id: "run",
      label: "Use skill package",
      description:
        "Load this native plugin for one Claude invocation. The original skill/agent instructions and Claude's permissions remain in effect.",
      input: true,
      inputMode: "prompt",
      parameters: [
        plugin,
        { key: "command", label: "Claude executable" },
        { key: "model", label: "Claude model" },
      ],
    },
  ],
  async execute(request, context) {
    const selected = parameter(request, "pluginPath");
    if (!isAbsolute(selected)) throw new Error("Select an absolute plugin folder path.");
    const path = await realpath(selected);
    const manifest = record(
      JSON.parse(await readFile(join(path, ".claude-plugin/plugin.json"), "utf8")),
    );
    if (typeof manifest.name !== "string" || !manifest.name)
      throw new Error("The selected folder is not a named native Claude plugin.");
    if (request.action === "inspect") {
      const entries = await readdir(join(path, "skills"), { withFileTypes: true }).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return [];
          throw error;
        },
      );
      return result({
        name: manifest.name,
        version: manifest.version,
        path,
        skills: entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name),
      });
    }
    if (request.action !== "run") throw new Error("Unknown skill package action.");
    const command = await context.resolveCommand(request.parameters.command || "claude");
    const response = await context.exec({
      command,
      args: [
        "--plugin-dir",
        path,
        "--output-format",
        "json",
        ...(request.parameters.model ? ["--model", request.parameters.model] : []),
        "-p",
        request.input,
      ],
      cwd: request.cwd,
      timeoutMs: 180000,
    });
    if (response.exitCode !== 0)
      throw new Error(
        `Claude could not run the native plugin: ${response.stderr || response.stdout}`,
      );
    const output = record(JSON.parse(response.stdout));
    if (output.is_error === true)
      throw new Error(
        `Claude reported a failed plugin turn: ${String(output.result ?? output.subtype)}`,
      );
    if (typeof output.result !== "string" || !output.result.trim())
      throw new Error("Claude did not return an assistant result for the native plugin turn.");
    return result(
      output.result,
      "completed",
      typeof output.session_id === "string" ? output.session_id : undefined,
    );
  },
};
