import { afterEach, beforeEach, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getArtifact, ArtifactStore } from "./artifacts.js";
import { MAX_SHARED_FILE_BYTES } from "../shared/contracts.js";
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "familiar-artifacts-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
it("round trips bytes and verifies an existing artifact before acknowledging it", async () => {
  const data = Buffer.from("shared file 한글\n");
  const input = {
    name: "../../file.txt",
    base64: data.toString("base64"),
    sha256: createHash("sha256").update(data).digest("hex"),
  };
  const store = new ArtifactStore(directory);
  const result = await store.put(input);
  expect(path.dirname(result.path)).toBe(directory);
  expect(await readFile(result.path)).toEqual(data);
  expect(await store.put(input)).toEqual(result);
  expect((await getArtifact(directory, path.basename(result.path))).sha256).toBe(input.sha256);
  await writeFile(result.path, "corrupt");
  await expect(store.put(input)).rejects.toThrow("checksum");
});
it("rejects traversal, symlink escape, oversize files and checksum mismatch", async () => {
  const root = path.join(directory, "workspace");
  await mkdir(root);
  const outside = path.join(directory, "outside.txt");
  await writeFile(outside, "private");
  await symlink(outside, path.join(root, "link.txt"));
  await expect(getArtifact(root, "../outside.txt")).rejects.toThrow("inside");
  await expect(getArtifact(root, "link.txt")).rejects.toThrow("inside");
  await writeFile(path.join(root, "large.bin"), Buffer.alloc(MAX_SHARED_FILE_BYTES + 1));
  await expect(getArtifact(root, "large.bin")).rejects.toThrow("4 MiB");
  await expect(
    new ArtifactStore(root).put({ name: "bad", base64: "YWJj", sha256: "0".repeat(64) }),
  ).rejects.toThrow("checksum");
});

it("enforces the quota under concurrent uploads while allowing verified retries when full", async () => {
  const store = new ArtifactStore(directory, 1);
  const data = Buffer.from("quota fixture");
  const input = {
    name: "first.txt",
    base64: data.toString("base64"),
    sha256: createHash("sha256").update(data).digest("hex"),
  };
  const [first, second] = await Promise.allSettled([
    store.put(input),
    store.put({ ...input, name: "second.txt" }),
  ]);
  expect(first.status).toBe("fulfilled");
  expect(second.status).toBe("rejected");
  if (first.status !== "fulfilled") throw first.reason;
  await expect(store.put(input)).resolves.toEqual(first.value);
  await writeFile(first.value.path, "corrupt");
  await expect(store.put(input)).rejects.toThrow("checksum");
});
