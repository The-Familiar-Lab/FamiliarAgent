import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readCompositionSource } from "../../shared/composition.js";
import type { ResourceReader } from "./store.js";

const execute = promisify(execFile);

/** Restored tunnels can start before the daemon SDK is ready; resolve native pages only on demand. */
export function localCliReader(cliPath: string | undefined, home: string): ResourceReader {
  return async (resource, input) => {
    if (!cliPath)
      throw new Error("FamiliarAgent CLI is unavailable; open this session to reconnect");
    const directory = await mkdtemp(path.join(os.tmpdir(), "familiar-context-"));
    try {
      const file = path.join(directory, "request.json");
      await writeFile(file, JSON.stringify({ resource, ...input }), { mode: 0o600 });
      const { stdout } = await execute(
        cliPath,
        [
          "plugin",
          "call",
          "familiar-workspace",
          readCompositionSource.name,
          "--home",
          home,
          "--input-file",
          file,
          "--json",
        ],
        { timeout: 25000, maxBuffer: 1024 * 1024, windowsHide: true },
      );
      const response = JSON.parse(stdout) as { result?: unknown };
      const result = readCompositionSource.output.parse(response.result);
      return {
        messages: result.messages,
        nextOffset: result.nextOffset,
        truncated: result.truncated,
        boundary: result.resource.boundary,
      };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  };
}
