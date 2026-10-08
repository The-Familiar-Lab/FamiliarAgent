import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
const execute = promisify(execFile);

export function authorityRequestError(error: unknown): Error {
  if (error && typeof error === "object") {
    for (const channel of ["stderr", "stdout"] as const) {
      if (!(channel in error)) continue;
      const text = Reflect.get(error, channel);
      if (typeof text !== "string" || text.length > 1024 * 1024) continue;
      try {
        const result: unknown = JSON.parse(text);
        if (!result || typeof result !== "object" || !("error" in result)) continue;
        const detail = result.error;
        if (!detail || typeof detail !== "object" || !("message" in detail)) continue;
        if (typeof detail.message === "string" && detail.message.trim())
          return new Error(detail.message, { cause: error });
      } catch {
        // CLI startup and transport failures may not have a structured response.
      }
    }
  }
  return error instanceof Error ? error : new Error(String(error));
}

export async function forwardWorkspace(
  authority: string,
  method: string,
  input: Record<string, unknown>,
  cliPath: string | undefined,
): Promise<unknown> {
  if (input.forwarded)
    throw new Error(
      "Shared authority forwarding must point directly to its storage server; forwarding chains are not supported.",
    );
  if (!cliPath) throw new Error("The FamiliarAgent launcher is not configured on this host.");
  const directory = await mkdtemp(path.join(os.tmpdir(), "familiar-rpc-"));
  try {
    const file = path.join(directory, "input.json");
    await writeFile(file, JSON.stringify({ ...input, forwarded: true }), { mode: 0o600 });
    const { stdout } = await execute(
      cliPath,
      [
        "plugin",
        "call",
        "familiar-workspace",
        method,
        "--input-file",
        file,
        "--host",
        authority,
        "--json",
      ],
      { timeout: 25000, maxBuffer: 1024 * 1024, windowsHide: true },
    ).catch((error: unknown) => {
      throw authorityRequestError(error);
    });
    const result: unknown = JSON.parse(stdout);
    if (!result || typeof result !== "object" || !("result" in result))
      throw new Error("Invalid authority response");
    return result.result;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
