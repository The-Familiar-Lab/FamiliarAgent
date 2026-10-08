import { createHash } from "node:crypto";
import { mkdir, open, realpath, readdir, writeFile, lstat } from "node:fs/promises";
import path from "node:path";
import { constants } from "node:fs";
import { MAX_SHARED_FILE_BYTES } from "../shared/contracts.js";
const digest = (data: Buffer) => createHash("sha256").update(data).digest("hex");
interface ArtifactInput {
  name: string;
  base64: string;
  sha256: string;
}
const DEFAULT_MAX_ARTIFACTS = 1024;

/** A single daemon owns this directory; serialize quota checks with publication. */
export class ArtifactStore {
  private pending: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly directory: string,
    private readonly maximumFiles = DEFAULT_MAX_ARTIFACTS,
  ) {
    if (!Number.isSafeInteger(maximumFiles) || maximumFiles < 1)
      throw new Error("Artifact file limit must be a positive integer");
  }
  put(input: ArtifactInput) {
    const next = this.pending
      .catch(() => {})
      .then(() => putArtifact(this.directory, input, this.maximumFiles));
    this.pending = next;
    return next;
  }
}

async function putArtifact(directory: string, input: ArtifactInput, maximumFiles: number) {
  const data = Buffer.from(input.base64, "base64");
  if (data.length > MAX_SHARED_FILE_BYTES || digest(data) !== input.sha256)
    throw new Error("File size or checksum mismatch");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const name = path
    .basename(input.name)
    .replace(/[^\p{L}\p{N}_.-]/gu, "_")
    .slice(-100);
  const destination = path.join(directory, `${input.sha256}-${name}`);
  const exists = await lstat(destination).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );
  if (!exists && (await readdir(directory)).length >= maximumFiles)
    throw new Error(
      "Shared file storage is full. Remove unneeded artifacts before uploading more.",
    );
  try {
    await writeFile(destination, data, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const file = await open(destination, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size !== data.length)
        throw new Error("An existing artifact failed checksum verification", { cause: error });
      const existing = Buffer.alloc(stat.size);
      const { bytesRead } = await file.read(existing, 0, existing.length, 0);
      if (bytesRead !== existing.length || digest(existing) !== input.sha256)
        throw new Error("An existing artifact failed checksum verification", { cause: error });
    } finally {
      await file.close();
    }
  }
  return { path: destination, size: data.length, sha256: input.sha256 };
}
export async function getArtifact(root: string, requestedPath: string) {
  const directory = await realpath(root);
  const destination = await realpath(path.resolve(directory, requestedPath));
  const relative = path.relative(directory, destination);
  if (
    !relative ||
    relative.startsWith(`..${path.sep}`) ||
    relative === ".." ||
    path.isAbsolute(relative)
  )
    throw new Error("File must be inside the bound agent workspace");
  const file = await open(destination, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_SHARED_FILE_BYTES)
      throw new Error("Only files up to 4 MiB can be sent through this shared channel");
    const data = Buffer.alloc(stat.size);
    const { bytesRead } = await file.read(data, 0, data.length, 0);
    if (bytesRead !== data.length) throw new Error("File changed while reading. Try again.");
    return {
      name: path.basename(destination),
      base64: data.toString("base64"),
      size: data.length,
      sha256: digest(data),
    };
  } finally {
    await file.close();
  }
}
