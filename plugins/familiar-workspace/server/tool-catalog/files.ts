import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, realpath, writeFile } from "node:fs/promises";
import path from "node:path";

export async function readJson(file: string): Promise<unknown | undefined> {
  try {
    if ((await stat(file)).size > 2 * 1024 * 1024) throw new Error("Configuration exceeds 2 MiB");
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
export async function writeJson(file: string, data: unknown): Promise<void> {
  return writeText(file, `${JSON.stringify(data, null, 2)}\n`);
}
export async function writeText(file: string, data: string, mode = 0o600): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, data, { mode, flag: "wx" });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}
export async function directory(value: string): Promise<string> {
  if (!path.isAbsolute(value)) throw new Error("An absolute folder path is required");
  const resolved = await realpath(value);
  if (!(await stat(resolved)).isDirectory()) throw new Error("The selected path is not a folder");
  return resolved;
}
