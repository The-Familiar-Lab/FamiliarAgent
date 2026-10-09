import path from "node:path";
import { pathToFileURL } from "node:url";
import { stat } from "node:fs/promises";
import { z } from "zod";
import type {
  ToolActionAdapter,
  ToolHttpRequest,
  ToolActionRequest,
  ToolActionContext,
  ToolActionResult,
} from "../tool-actions/contracts.js";
import {
  binaryParameter,
  cli,
  httpEndpoint,
  inputText,
  jsonOutput,
  parameter,
  privateProfile,
  profileParameter,
  safePathPart,
} from "./common.js";
const profileSchema = z
  .object({
    metadataUrl: z.string().min(1).optional(),
    webdavUrl: httpEndpoint.optional(),
    username: z.string().optional(),
    password: z.string().optional(),
  })
  .strict();
const common = [profileParameter];
export const juicefsAdapter: ToolActionAdapter = {
  id: "juicefs",
  actions: [
    {
      id: "status",
      mutates: false,
      label: "Volume status",
      description:
        "Read JuiceFS metadata and active clients. Ask setup can connect an existing volume through a private profile; no system mount is required.",
      parameters: [...common, binaryParameter],
    },
    {
      id: "list",
      mutates: false,
      label: "List shared files",
      description: "List one directory through the original JuiceFS WebDAV gateway.",
      parameters: [...common, { key: "path", label: "Shared directory (optional)" }],
    },
    {
      id: "read",
      mutates: false,
      label: "Read shared file",
      description: "Read a bounded text file through JuiceFS WebDAV (64 KiB result limit).",
      parameters: [...common, { key: "path", label: "Shared file path", required: true }],
    },
    {
      id: "write",
      label: "Write shared file",
      input: true,
      inputMode: "data",
      description: "Write this text through JuiceFS WebDAV to the selected path.",
      parameters: [...common, { key: "path", label: "Shared file path", required: true }],
    },
    {
      id: "mkdir",
      label: "Create shared directory",
      description: "Create a directory through native WebDAV.",
      parameters: [...common, { key: "path", label: "Shared directory path", required: true }],
    },
    {
      id: "upload",
      label: "Upload with JuiceFS",
      description:
        "Use juicefs sync with native metadata/storage; no FUSE or bulk history copying.",
      parameters: [
        ...common,
        binaryParameter,
        { key: "source", label: "Local file", required: true },
        { key: "path", label: "Shared destination path", required: true },
      ],
    },
    {
      id: "download",
      label: "Download with JuiceFS",
      description: "Use native juicefs sync to download one shared path into this result folder.",
      parameters: [
        ...common,
        binaryParameter,
        { key: "path", label: "Shared source path", required: true },
      ],
    },
  ],
  async execute(request, context) {
    const profile = await privateProfile(parameter(request, "profile"), profileSchema);
    const secrets = privateValues(profile);
    const redact = (value: string) =>
      secrets.reduce((text, secret) => text.replaceAll(secret, "[private connection]"), value);
    if (["status", "upload", "download"].includes(request.action))
      return executeNative(request, context, profile, redact);
    if (!profile.webdavUrl)
      throw new Error("This action requires webdavUrl in the private JuiceFS profile");
    const relative = safePathPart(parameter(request, "path", request.action !== "list"));
    const url = profile.webdavUrl.replace(/\/+$/u, "") + "/" + relative;
    const headers: Record<string, string> = {};
    if (profile.username || profile.password)
      headers.Authorization =
        "Basic " +
        Buffer.from(`${profile.username ?? ""}:${profile.password ?? ""}`).toString("base64");
    let method: ToolHttpRequest["method"];
    if (request.action === "read") method = "GET";
    else if (request.action === "list") {
      method = "PROPFIND";
      headers.Depth = "1";
    } else if (request.action === "write") {
      method = "PUT";
      headers["Content-Type"] = "text/plain; charset=utf-8";
    } else if (request.action === "mkdir") method = "MKCOL";
    else throw new Error("Unknown JuiceFS action");
    const response = await context.request({
      url,
      method,
      headers,
      ...(request.action === "write" ? { body: inputText(request) } : {}),
      maxBytes: 256 * 1024,
      timeoutMs: 30_000,
    });
    if (response.status < 200 || response.status >= 300)
      throw new Error(`JuiceFS WebDAV returned HTTP ${response.status}`);
    return {
      state: "completed",
      text: redact(response.body || `JuiceFS ${request.action} completed: ${relative}`),
      nativeId: relative,
    };
  },
};

async function executeNative(
  request: ToolActionRequest,
  context: ToolActionContext,
  profile: z.infer<typeof profileSchema>,
  redact: (value: string) => string,
): Promise<ToolActionResult> {
  if (!profile.metadataUrl)
    throw new Error("This action requires metadataUrl in the private JuiceFS profile");
  let args: string[];
  const output = path.join(context.runDirectory, "download");
  if (request.action === "status") args = ["status", profile.metadataUrl];
  else {
    const relative = safePathPart(parameter(request, "path"));
    if (!relative) throw new Error("Choose one file path, not the volume root");
    const native = `jfs://familiar_volume/${relative}`;
    if (request.action === "upload") {
      const source = path.resolve(request.cwd, parameter(request, "source"));
      if (!(await stat(source)).isFile()) throw new Error("Upload source must be one regular file");
      args = ["sync", "--threads", "2", "--check-new", pathToFileURL(source).href, native];
    } else args = ["sync", "--threads", "2", "--check-new", native, pathToFileURL(output).href];
  }
  let text: string;
  try {
    text = await cli(request, context, "juicefs", args, {
      env: { familiar_volume: profile.metadataUrl },
    });
  } catch (error) {
    // Native diagnostics may contain private metadata credentials; do not retain an unredacted cause.
    // eslint-disable-next-line preserve-caught-error
    throw new Error(redact(error instanceof Error ? error.message : "JuiceFS command failed"));
  }
  return {
    state: "completed",
    text: redact(request.action === "status" ? jsonOutput(text) : text),
    ...(request.action === "download"
      ? { artifacts: [{ path: output, label: "JuiceFS file" }] }
      : {}),
  };
}

function privateValues(profile: z.infer<typeof profileSchema>): string[] {
  const values = [profile.metadataUrl, profile.password];
  if (profile.metadataUrl) {
    try {
      const password = new URL(profile.metadataUrl).password;
      values.push(password, decodeURIComponent(password));
    } catch {
      /* Native metadata schemes are validated by JuiceFS itself. */
    }
  }
  return values.filter((value): value is string => !!value);
}
