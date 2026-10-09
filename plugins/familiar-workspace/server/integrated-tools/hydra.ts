import { writeFile, readFile } from "node:fs/promises";
import { isAbsolute, join, dirname, resolve } from "node:path";
import { HYDRA_COMPAT } from "./hydra-compat.js";
import type { ToolActionAdapter } from "../tool-actions/contracts.js";
import { integer, jsonRequest, nativeId, parameter, record, result } from "./common.js";

const socket = {
  key: "socketPath",
  label: "Hydra socket",
  required: true,
  description: "Native daemon socket on this server (daemon --socket-path).",
};

export const hydraAdapter: ToolActionAdapter = {
  id: "hydra",
  actions: [
    {
      id: "prepare",
      label: "Prepare Hydra launcher",
      description:
        "Prepare an explicit launcher for the original Hydra 0.2.x daemon, adding Claude's required stream verbosity. Does not start it or alter its profile.",
      parameters: [
        socket,
        { key: "daemonPath", label: "Built Hydra out/main/daemon.js", required: true },
        { key: "dataRoot", label: "Dedicated Hydra data folder", required: true },
        { key: "nodeCommand", label: "Node executable" },
      ],
    },
    {
      id: "list",
      mutates: false,
      label: "List Hydra runs",
      description: "Read the original headless run catalog.",
      parameters: [socket],
    },
    {
      id: "run",
      label: "Run with Hydra",
      description:
        "Hydra owns the Claude subprocess, run history and permissions. This returns a submitted run ID.",
      input: true,
      inputMode: "prompt",
      parameters: [socket, { key: "model", label: "Claude model", required: true }],
    },
    {
      id: "read",
      mutates: false,
      label: "Read Hydra run",
      description: "Read native run status and bounded output.",
      nativeId: true,
      parameters: [socket, { key: "lines", label: "Maximum lines" }],
    },
  ],
  async execute(request, context) {
    const socketPath = parameter(request, "socketPath");
    if (request.action === "prepare") {
      const daemonPath = parameter(request, "daemonPath");
      const dataRoot = parameter(request, "dataRoot");
      if (![daemonPath, dataRoot, socketPath].every(isAbsolute))
        throw new Error("Choose absolute Hydra daemon, profile and socket paths.");
      const metadata = record(
        JSON.parse(await readFile(resolve(dirname(daemonPath), "../..", "package.json"), "utf8")),
      );
      if (typeof metadata.version !== "string" || !metadata.version.startsWith("0.2."))
        throw new Error(
          "This compatibility launcher supports the verified Hydra 0.2.x daemon only.",
        );
      const launcher = join(context.runDirectory, "hydra-launcher.cjs");
      const command = await context.resolveCommand(request.parameters.nodeCommand || "node");
      await writeFile(
        launcher,
        `process.env.FAMILIAR_HYDRA_COMPAT='1';\nprocess.argv=${JSON.stringify([command, daemonPath, "--socket-path", socketPath, "--user-data", dataRoot])};\n${HYDRA_COMPAT}\nrequire(${JSON.stringify(daemonPath)});\n`,
        { mode: 0o600 },
      );
      return {
        state: "completed",
        text: JSON.stringify(
          {
            command,
            args: [launcher],
            note: "Run this launcher to start the original daemon, then select Run with Hydra using the same socket. Keep the dedicated profile separate from your desktop profile.",
          },
          null,
          2,
        ),
        artifacts: [{ path: launcher, label: "Hydra compatibility launcher" }],
      };
    }
    if (!isAbsolute(socketPath)) throw new Error("Select an absolute Hydra socket path.");
    const call = (path: string, body?: unknown) =>
      jsonRequest(context, {
        url: `http://localhost${path}`,
        socketPath,
        method: body ? "POST" : "GET",
        ...(body ? { body } : {}),
      });
    if (request.action === "list") return result(await call("/headless?status=all&limit=100"));
    if (request.action === "run") {
      const run = record(
        await call("/headless", {
          prompt: request.input,
          projectDir: request.cwd,
          provider: "claude",
          model: parameter(request, "model"),
        }),
      );
      if (typeof run.id !== "string") throw new Error("Hydra did not return a run ID.");
      return result(run, "submitted", run.id);
    }
    if (request.action === "read") {
      const id = nativeId(request);
      const path = `/headless/${encodeURIComponent(id)}`;
      const run = record(await call(path));
      const log = await call(
        `${path}/log?tailLines=${integer(request.parameters.lines, 200, 2000)}&maxChars=65536`,
      );
      return result({ run, log }, run.status === "running" ? "submitted" : "completed", id);
    }
    throw new Error("Unknown Hydra action.");
  },
};
