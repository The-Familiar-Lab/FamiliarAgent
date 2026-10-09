import { createHash } from "node:crypto";
import path from "node:path";
import type { ToolActionAdapter, ToolActionContext } from "../tool-actions/contracts.js";
import { inputFile, nativeId, objectJson, runNative } from "./common.js";

async function queueWithEvidence(
  value: object,
  id: string,
  cwd: string,
  env: Record<string, string> | undefined,
  context: ToolActionContext,
): Promise<string> {
  if (Array.isArray(value) || !("qitemId" in value) || value.qitemId !== id)
    throw new Error("OpenRig returned a different queue item");
  const transitions: unknown = JSON.parse(
    await runNative(context, {
      command: "rig",
      args: ["queue", "transitions", id, "--json"],
      cwd,
      env,
    }),
  );
  if (!Array.isArray(transitions) || transitions.some((entry) => !entry || entry.qitemId !== id))
    throw new Error("OpenRig returned invalid queue transitions");
  return JSON.stringify({ item: value, transitions }, null, 2);
}

export const openrigAdapter: ToolActionAdapter = {
  id: "openrig",
  actions: [
    {
      id: "list-seats",
      label: "List OpenRig seats",
      description: "Read the original running rig and seat inventory.",
      mutates: false,
    },
    {
      id: "submit-work",
      label: "Submit OpenRig work",
      description:
        "Create a durable native queue item for the selected agent seat. Acknowledgement means submitted, not completed.",
      input: true,
      inputMode: "prompt" as const,
      nativeId: true,
    },
    {
      id: "read-work",
      label: "Read OpenRig work",
      description:
        "Read the original queue item, current state and agent-authored transition notes.",
      nativeId: true,
      mutates: false,
    },
    {
      id: "capture-seat",
      label: "Read OpenRig seat output",
      description: "Capture the original agent terminal without sending keystrokes.",
      nativeId: true,
      mutates: false,
    },
  ].map((action) =>
    Object.assign(action, {
      parameters: [
        {
          key: "home",
          label: "OpenRig home",
          description: "Optional existing OpenRig home. Uses the native default when empty.",
        },
      ],
    }),
  ),
  async execute(request, context) {
    const home = request.parameters.home;
    if (home && !path.isAbsolute(home)) throw new Error("OpenRig home must be absolute");
    const env = home ? { OPENRIG_HOME: home } : undefined;
    let args: string[];
    let id: string | undefined;
    if (request.action === "list-seats") args = ["ps", "--json"];
    else if (request.action === "read-work") {
      id = nativeId(request);
      args = ["queue", "show", id, "--full", "--json"];
    } else if (request.action === "capture-seat") {
      id = nativeId(request);
      args = ["capture", id, "--lines", "200", "--json"];
    } else if (request.action === "submit-work") {
      const destination = nativeId(request);
      if (
        !/^[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+$/u.test(destination) ||
        destination.startsWith("human@")
      )
        throw new Error("Select an OpenRig agent seat as member@rig");
      id = `familiar-${createHash("sha256").update(context.runDirectory).digest("hex").slice(0, 32)}`;
      args = [
        "queue",
        "create",
        "--source",
        "familiaragent",
        "--destination",
        destination,
        "--body-file",
        await inputFile(context, request.input),
        "--summary",
        "FamiliarAgent connected input",
        "--id",
        id,
        "--json",
      ];
    } else throw new Error("Unsupported OpenRig action");
    const output = await runNative(context, { command: "rig", args, cwd: request.cwd, env });
    const value: unknown = JSON.parse(output);
    if (request.action === "submit-work") {
      const result = objectJson(output);
      if (result.error || result.qitemId !== id || result.destinationSession !== request.nativeId)
        throw new Error("OpenRig did not acknowledge the requested queue item");
      return { state: "submitted", text: output, nativeId: id };
    }
    if (!value || typeof value !== "object" || (!Array.isArray(value) && "error" in value))
      throw new Error("OpenRig returned an invalid or failed response");
    if (request.action === "read-work")
      return {
        state: "completed",
        text: await queueWithEvidence(value, nativeId(request), request.cwd, env, context),
        nativeId: id,
      };
    return { state: "completed", text: output, nativeId: id };
  },
};
