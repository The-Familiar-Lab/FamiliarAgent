import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  ToolActionContext,
  ToolActionRequest,
  ToolCommand,
} from "../tool-actions/contracts.js";

export { NATIVE_OUTPUT_LIMIT, readBounded } from "./native-files.js";
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
export function objectJson(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Native tool returned an invalid JSON object");
  return value as Record<string, unknown>;
}
