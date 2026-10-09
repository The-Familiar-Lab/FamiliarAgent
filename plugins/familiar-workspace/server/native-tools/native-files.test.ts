import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NATIVE_OUTPUT_LIMIT, readBounded, realpathsBounded } from "./native-files.js";

let folder: string;
beforeEach(async () => {
  folder = await mkdtemp(path.join(os.tmpdir(), "native-read ' "));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(folder, { recursive: true, force: true });
});
it("reads exact UTF-8 content and the full permitted boundary", async () => {
  const file = path.join(folder, "quoted ' history.md");
  await writeFile(file, "한글\n`literal` ${input}\u0000");
  expect(await readBounded(file)).toBe("한글\n`literal` ${input}\u0000");
  await writeFile(file, "a".repeat(NATIVE_OUTPUT_LIMIT));
  expect((await readBounded(file)).length).toBe(NATIVE_OUTPUT_LIMIT);
});
it("preserves missing-file codes and rejects directories and oversized artifacts", async () => {
  await expect(readBounded(path.join(folder, "missing"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readBounded(folder)).rejects.toThrow("not a regular file");
  const file = path.join(folder, "large");
  await writeFile(file, "a".repeat(NATIVE_OUTPUT_LIMIT + 1));
  await expect(readBounded(file)).rejects.toThrow("512 KiB");
});
it("rejects an artifact that exceeds its earlier stat size during the bounded read", async () => {
  const file = path.join(folder, "growing");
  await writeFile(file, "a".repeat(NATIVE_OUTPUT_LIMIT + 1));
  const preload = path.join(folder, "earlier-stat.cjs");
  await writeFile(
    preload,
    `const fs=require('node:fs/promises');const open=fs.open;fs.open=async (...args)=>{const handle=await open(...args),stat=handle.stat.bind(handle);handle.stat=async()=>{const value=await stat();value.size=0;return value;};return handle;};`,
  );
  vi.stubEnv("NODE_OPTIONS", `--require=${JSON.stringify(preload)}`);
  await expect(readBounded(file)).rejects.toThrow("grew beyond 512 KiB");
});
it("resolves selected paths in the reader process and preserves absent candidates", async () => {
  const target = path.join(folder, "target");
  await mkdir(target);
  const link = path.join(folder, "link");
  await symlink(target, link);
  const paths = await realpathsBounded([target, link, path.join(folder, "missing")]);
  expect(paths[0]).toBe(paths[1]);
  expect(paths[2]).toBeNull();
});
it.skipIf(process.platform === "win32")(
  "times out a real FIFO open without blocking later reads",
  async () => {
    const fifo = path.join(folder, "blocked");
    await promisify(execFile)("mkfifo", [fifo]);
    await expect(readBounded(fifo)).rejects.toThrow("timed out");
    const file = path.join(folder, "ready");
    await writeFile(file, "still responsive");
    expect(await readBounded(file)).toBe("still responsive");
  },
);
it.skipIf(process.platform === "win32")(
  "cancels a blocked reader and honors an already-aborted request",
  async () => {
    const fifo = path.join(folder, "blocked");
    await promisify(execFile)("mkfifo", [fifo]);
    const controller = new AbortController();
    const pending = readBounded(fifo, controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow("cancelled");
    await expect(readBounded(fifo, controller.signal)).rejects.toThrow();
  },
);
