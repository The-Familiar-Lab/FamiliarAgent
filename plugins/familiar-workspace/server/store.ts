import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { workspaceDocument, spaceId, type WorkspaceDocument } from "../shared/contracts.js";

/** One authority process owns writes. Clients use revision checks, never last-writer-wins. */
export class WorkspaceStore {
  private writes = new Map<string, Promise<unknown>>();
  constructor(private readonly directory: string) {}
  private file(id: string): string {
    return path.join(
      this.directory,
      `${createHash("sha256").update(spaceId.parse(id)).digest("hex")}.json`,
    );
  }
  async read(id: string): Promise<WorkspaceDocument> {
    const file = this.file(id);
    try {
      return workspaceDocument.parse(JSON.parse(await readFile(file, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return { id, revision: 0, updatedAt: "", notes: "", mappings: [], tools: [] };
    }
  }
  async list(): Promise<{ id: string; revision: number; updatedAt: string }[]> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const files = (await readdir(this.directory)).filter((name) =>
      /^[a-f0-9]{64}\.json$/u.test(name),
    );
    const documents = [];
    for (const file of files) {
      const { id, revision, updatedAt } = workspaceDocument.parse(
        JSON.parse(await readFile(path.join(this.directory, file), "utf8")),
      );
      documents.push({ id, revision, updatedAt });
    }
    return documents.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  save(raw: WorkspaceDocument): Promise<WorkspaceDocument> {
    const document = workspaceDocument.parse(raw);
    const previous = this.writes.get(document.id) ?? Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(async () => {
        const current = await this.read(document.id);
        if (current.revision !== document.revision)
          throw new Error(
            `Revision conflict: current revision is ${current.revision}. Reload before saving; your edits have been kept.`,
          );
        const result = {
          ...document,
          revision: current.revision + 1,
          updatedAt: new Date().toISOString(),
        };
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        await this.writeDocument(result);
        return result;
      });
    this.writes.set(document.id, next);
    void next
      .finally(() => {
        if (this.writes.get(document.id) === next) this.writes.delete(document.id);
      })
      .catch(() => {});
    return next;
  }
  private async writeDocument(result: WorkspaceDocument): Promise<void> {
    const target = this.file(result.id);
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(JSON.stringify(result));
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
