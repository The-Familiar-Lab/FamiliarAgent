import { z } from "zod";
import type {
  ToolActionAdapter,
  ToolHttpRequest,
  ToolActionRequest,
} from "../tool-actions/contracts.js";
import {
  binaryParameter,
  cli,
  httpEndpoint,
  inputText,
  nativeId,
  parameter,
  privateProfile,
  profileParameter,
  jsonOutput,
} from "./common.js";
const profileSchema = z.object({ url: httpEndpoint, token: z.string().min(1).optional() }).strict();
const api = [profileParameter];
export const firetowerAdapter: ToolActionAdapter = {
  id: "firetower",
  actions: [
    {
      id: "doctor",
      mutates: false,
      label: "Check worker",
      description: "Run the original Firetower worker readiness checks.",
      parameters: [
        binaryParameter,
        { key: "workerRoot", label: "Native worker state directory", required: true },
      ],
    },
    {
      id: "agents",
      mutates: false,
      label: "Installed worker agents",
      description: "List the original worker-managed agent installations.",
      parameters: [
        binaryParameter,
        { key: "workerRoot", label: "Native worker state directory", required: true },
      ],
    },
    {
      id: "hosts",
      mutates: false,
      label: "List compute hosts",
      description:
        "Read the existing Firetower compute pool. Ask setup can create a private profile pointing to its authenticated original service.",
      parameters: api,
    },
    {
      id: "readiness",
      mutates: false,
      label: "Check host readiness",
      nativeId: true,
      description:
        "Check the original worker, Git, tmux and installed agent requirements for a host ID.",
      parameters: api,
    },
    {
      id: "repositories",
      mutates: false,
      label: "List repositories",
      description: "Read Firetower repository definitions.",
      parameters: api,
    },
    {
      id: "sessions",
      mutates: false,
      label: "List native sessions",
      description: "Read native session IDs and runtime state.",
      parameters: api,
    },
    {
      id: "session",
      mutates: false,
      label: "Session details",
      nativeId: true,
      description: "Read the native workspace and agent state.",
      parameters: api,
    },
    {
      id: "conversation",
      mutates: false,
      label: "Read conversation",
      nativeId: true,
      description: "Read the original native conversation through Firetower; bounded result.",
      parameters: api,
    },
    {
      id: "files",
      mutates: false,
      label: "List workspace files",
      nativeId: true,
      description: "Read files in the native worker workspace.",
      parameters: [...api, { key: "path", label: "Workspace relative directory (optional)" }],
    },
    {
      id: "file",
      mutates: false,
      label: "Read workspace file",
      nativeId: true,
      description: "Read a file through the original worker API.",
      parameters: [...api, { key: "path", label: "Workspace relative file", required: true }],
    },
    {
      id: "create",
      label: "Create native workspace",
      description:
        "Firetower selects or uses a host and creates its own workspace. Omit input to start without a model turn.",
      parameters: [
        ...api,
        {
          key: "agent",
          label: "Native agent: ClaudeCode, Codex or KimiCode",
          required: true,
        },
        { key: "hostId", label: "Host ID (optional)" },
        { key: "repoId", label: "Repository ID (optional)" },
        { key: "name", label: "Workspace name (optional)" },
      ],
    },
    {
      id: "send",
      label: "Send native input",
      nativeId: true,
      input: true,
      inputMode: "prompt",
      description: "Acknowledge one native turn; the Firetower runtime owns its execution.",
      parameters: api,
    },
    {
      id: "stop",
      label: "Stop native agent",
      nativeId: true,
      description: "Stop this native agent while preserving its workspace.",
      parameters: api,
    },
  ],
  async execute(request, context) {
    if (request.action === "doctor" || request.action === "agents") {
      const text = await cli(request, context, "firetower-worker", [
        "--root",
        parameter(request, "workerRoot"),
        request.action,
      ]);
      return { state: "completed", text };
    }
    const profile = await privateProfile(parameter(request, "profile"), profileSchema);
    let { route, method, body, id } = firetowerRequest(request);
    const response = await context.request({
      url: profile.url.replace(/\/+$/u, "") + "/api/v1" + route,
      method,
      ...(body ? { body } : {}),
      headers: profile.token ? { Authorization: `Bearer ${profile.token}` } : {},
      timeoutMs: 30_000,
      maxBytes: 256 * 1024,
    });
    if (response.status < 200 || response.status >= 300)
      throw new Error(
        `Firetower returned HTTP ${response.status}: ${firetowerError(response.body, profile.token)}`,
      );
    if (request.action === "create") {
      const session = z.object({ id: z.string().min(1) }).parse(JSON.parse(response.body));
      id = session.id;
    }
    let text = `Firetower ${request.action} acknowledged`;
    if (response.body) text = request.action === "file" ? response.body : jsonOutput(response.body);
    return {
      state: ["create", "send", "stop"].includes(request.action) ? "submitted" : "completed",
      text,
      ...(id ? { nativeId: id } : {}),
    };
  },
};

function firetowerRequest(request: ToolActionRequest) {
  let route: string;
  let method: ToolHttpRequest["method"] = "GET";
  let body: unknown;
  let id: string | undefined;
  if (request.action === "hosts") route = "/hosts";
  else if (request.action === "readiness")
    route = "/hosts/" + encodeURIComponent(nativeId(request)) + "/readiness";
  else if (request.action === "repositories") route = "/repos";
  else if (request.action === "sessions") route = "/sessions";
  else if (request.action === "create") {
    route = "/sessions";
    method = "POST";
    const agent = parameter(request, "agent");
    if (!["ClaudeCode", "Codex", "KimiCode"].includes(agent))
      throw new Error("Unknown Firetower agent");
    body = {
      agent,
      ...(request.input.trim() ? { prompt: inputText(request) } : {}),
      ...Object.fromEntries(
        ["hostId", "repoId", "name"].flatMap((key) =>
          parameter(request, key, false) ? [[key, parameter(request, key)]] : [],
        ),
      ),
    };
  } else {
    id = nativeId(request);
    route = "/sessions/" + encodeURIComponent(id);
    if (request.action === "conversation") route += "/conversation";
    else if (request.action === "files" || request.action === "file")
      route +=
        "/" +
        request.action +
        "?" +
        new URLSearchParams({ path: parameter(request, "path", request.action === "file") });
    else if (request.action === "send") {
      route += "/turn";
      method = "POST";
      body = { text: inputText(request) };
    } else if (request.action === "stop") {
      route += "/stop";
      method = "POST";
    } else if (request.action !== "session") throw new Error("Unknown Firetower action");
  }

  return { route, method, body, id };
}

function firetowerError(body: string, token?: string): string {
  let message = "Open its native UI to inspect permissions or readiness";
  try {
    const parsed = z.object({ message: z.string() }).safeParse(JSON.parse(body));
    if (parsed.success) message = parsed.data.message.slice(0, 2000);
  } catch {
    /* Error pages are not trustworthy JSON diagnostics. */
  }
  return token ? message.replaceAll(token, "[private connection]") : message;
}
