import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { ToolActionContext, ToolActionRequest } from "../tool-actions/contracts.js";

export const ACTION_TIMEOUT_MS = 120_000;
export const ACTION_OUTPUT_BYTES = 256 * 1024;
export const binaryParameter = {
  key: "binary",
  label: "Native executable",
  description:
    "Optional absolute path; otherwise uses the installed command in the selected server’s FamiliarAgent tools/bin or PATH. Ask setup can install the original release.",
};
export const profileParameter = {
  key: "profile",
  label: "Private connection file",
  required: true,
  description: "Absolute path to a user-owned JSON file (0600). Credentials stay in that file.",
};
export function parameter(request: ToolActionRequest, key: string, required = true): string {
  const value = request.parameters[key]?.trim() ?? "";
  if (required && !value) throw new Error(`Missing ${key}`);
  if (value.includes("\0")) throw new Error(`Invalid ${key}`);
  return value;
}
export function nativeId(request: ToolActionRequest): string {
  const value = request.nativeId?.trim();
  if (
    !value ||
    value.startsWith("-") ||
    [...value].some((character) => character.charCodeAt(0) < 32)
  )
    throw new Error("Choose a valid native workspace or session identifier");
  return value;
}
export function inputText(request: ToolActionRequest): string {
  if (!request.input.trim()) throw new Error("Enter the native command or input to send");
  if (Buffer.byteLength(request.input) > 64 * 1024 || request.input.includes("\0"))
    throw new Error("Input exceeds 64 KiB or contains a null byte");
  return request.input;
}
export async function privateProfile<T>(file: string, schema: z.ZodType<T>): Promise<T> {
  if (!path.isAbsolute(file)) throw new Error("Connection file must use an absolute path");
  const stat = await lstat(file);
  if (
    !stat.isFile() ||
    stat.size > 64 * 1024 ||
    (stat.mode & 0o077) !== 0 ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw new Error(
      "Connection file must be a user-owned regular file, no larger than 64 KiB, with permissions 0600",
    );
  try {
    return schema.parse(JSON.parse(await readFile(file, "utf8")));
  } catch {
    throw new Error("Connection file does not match this tool's documented profile format");
  }
}
export const httpEndpoint = z
  .string()
  .url()
  .superRefine((value, ctx) => {
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      ctx.addIssue({
        code: "custom",
        message: "Endpoint must be HTTP(S) without credentials, query or fragment",
      });
    if (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
      ctx.addIssue({ code: "custom", message: "Use HTTPS or an SSH-forwarded loopback endpoint" });
  });
export async function cli(
  request: ToolActionRequest,
  context: ToolActionContext,
  command: string,
  args: string[],
  options: { env?: Record<string, string>; stdin?: string; timeoutMs?: number } = {},
) {
  const executable = await context.resolveCommand(parameter(request, "binary", false) || command);
  const result = await context.exec({
    command: executable,
    args,
    cwd: request.cwd,
    timeoutMs: ACTION_TIMEOUT_MS,
    maxBytes: ACTION_OUTPUT_BYTES,
    ...options,
  });
  if (result.exitCode !== 0)
    throw new Error(
      `${command} exited ${result.exitCode}: ${(result.stderr || result.stdout || "No diagnostic output").slice(-4000)}`,
    );
  return result.stdout.trim() || result.stderr.trim() || `${command} completed successfully`;
}
export function jsonOutput(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    throw new Error("Native tool returned invalid JSON; check its version and connection");
  }
}
export function safePathPart(value: string): string {
  if (
    value.includes("\\") ||
    value.split("/").some((part) => part === "..") ||
    [...value].some((character) => character.charCodeAt(0) < 32)
  )
    throw new Error("Use a relative native path without parent traversal");
  return value.replace(/^\/+/, "").split("/").map(encodeURIComponent).join("/");
}
