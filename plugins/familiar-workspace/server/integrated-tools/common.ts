import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type {
  ToolActionContext,
  ToolActionRequest,
  ToolActionResult,
} from "../tool-actions/contracts.js";

export function parameter(request: ToolActionRequest, key: string): string {
  const value = request.parameters[key]?.trim();
  if (!value) throw new Error(`Specify ${key} for this native tool.`);
  return value;
}

export function nativeId(request: ToolActionRequest): string {
  if (!request.nativeId?.trim()) throw new Error("Select a native session or run ID.");
  return request.nativeId;
}

export function integer(value: string | undefined, fallback: number, max: number): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max)
    throw new Error(`Expected a whole number between 1 and ${max}.`);
  return parsed;
}

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("The native tool returned an unexpected response.");
  return value as Record<string, unknown>;
}

export function result(
  value: unknown,
  state: ToolActionResult["state"] = "completed",
  id?: string,
): ToolActionResult {
  return {
    state,
    text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
    ...(id ? { nativeId: id } : {}),
  };
}

export async function cli(
  request: ToolActionRequest,
  context: ToolActionContext,
  command: string,
  args: string[],
  state: ToolActionResult["state"] = "completed",
): Promise<ToolActionResult> {
  const executable = await context.resolveCommand(request.parameters.command || command);
  const response = await context.exec({ command: executable, args, cwd: request.cwd });
  if (response.exitCode !== 0)
    throw new Error(
      `${command} exited with ${response.exitCode}: ${response.stderr || response.stdout}`,
    );
  return result(response.stdout, state, request.nativeId);
}

/** Read only the explicitly selected credential file; never persist the token in an operation. */
export async function tokenFile(path: string): Promise<string> {
  if (!isAbsolute(path))
    throw new Error("The token file must be an absolute path on the selected server.");
  const file = await open(path, "r");
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 4096)
      throw new Error("The token file must be a small regular text file.");
    const token = (await file.readFile("utf8")).trim();
    if (
      !token ||
      token.includes("\r") ||
      token.includes("\n") ||
      token.includes(String.fromCharCode(0))
    )
      throw new Error("The token file must contain one nonempty token.");
    return token;
  } finally {
    await file.close();
  }
}

export async function jsonRequest(
  context: ToolActionContext,
  options: Parameters<ToolActionContext["request"]>[0],
): Promise<unknown> {
  const response = await context.request(options);
  if (response.status < 200 || response.status >= 300)
    throw new Error(
      `Native API returned HTTP ${response.status}. Check its connection, credentials and native application logs.`,
    );
  try {
    return JSON.parse(response.body);
  } catch {
    throw new Error("The native API did not return JSON.");
  }
}

export function endpoint(base: string, path: string): string {
  const url = new URL(base);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("Use an HTTP(S) server URL without credentials, query or fragment.");
  url.pathname = `${url.pathname.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
  return url.toString();
}
