import { open, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  ToolActionContext,
  ToolActionRequest,
  ToolCommand,
} from "../tool-actions/contracts.js";

export const NATIVE_OUTPUT_LIMIT = 512 * 1024;
export async function runNative(context: ToolActionContext, command: ToolCommand): Promise<string> {
  const result = await context.exec({
    ...command,
    command: await context.resolveCommand(command.command),
  });
  if (result.exitCode !== 0)
    throw new Error(
      `Native tool exited with code ${result.exitCode}. Open the original tool to inspect its authentication, configuration and task state.`,
    );
  return result.stdout;
}
export function required(value: string | undefined, label: string): string {
  if (!value?.trim() || value.includes("\0")) throw new Error(`${label} is required`);
  return value;
}
export function nativeId(request: ToolActionRequest): string {
  const id = required(request.nativeId, "Native session ID");
  if (id.startsWith("-") || /[\r\n]/u.test(id)) throw new Error("Invalid native session ID");
  return id;
}
export function optionalFlag(args: string[], flag: string, value: string | undefined): void {
  if (value?.trim()) args.push(flag, value);
}
export async function inputFile(context: ToolActionContext, input: string): Promise<string> {
  required(input, "Input");
  await mkdir(context.runDirectory, { recursive: true, mode: 0o700 });
  const filename = path.join(context.runDirectory, "input.txt");
  await writeFile(filename, input, { mode: 0o600 });
  return filename;
}
export async function readBounded(filename: string): Promise<string> {
  const handle = await open(filename, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > NATIVE_OUTPUT_LIMIT)
      throw new Error("Native artifact is not a regular file below 512 KiB");
    const buffer = Buffer.alloc(NATIVE_OUTPUT_LIMIT + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > NATIVE_OUTPUT_LIMIT) throw new Error("Native artifact grew beyond 512 KiB");
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}
export function objectJson(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Native tool returned an invalid JSON object");
  return value as Record<string, unknown>;
}
