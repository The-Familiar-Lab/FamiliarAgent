import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { z } from "zod";
import type { ResultSourceSelection } from "../../shared/result-selection.js";
import {
  bindComposition,
  compositionProject,
  compositionSession,
  createComposition,
  forkComposition,
  listComposition,
  readCompositionContext,
  readCompositionResource,
  saveCompositionProject,
  updateComposition,
  type CompositionEndpoint,
  type CompositionProject,
  type CompositionResource,
  type CompositionSession,
  type HistoryBoundary,
} from "../../shared/composition.js";

export const MAX_COMPOSITION_ANCESTRY = 32;
const MAX_DOCUMENT_BYTES = 1024 * 1024;
type Kind = "project" | "session";
type Document = CompositionProject | CompositionSession;
function requestDigest(method: string, input: { operationId: string; forwarded?: boolean }) {
  const { forwarded: _forwarded, ...request } = input;
  return createHash("sha256")
    .update(JSON.stringify([method, request]))
    .digest("hex");
}
interface DataRow extends Record<string, SQLOutputValue> {
  data: string;
}
export type ResourceReader = (
  resource: CompositionResource,
  page: {
    offset: number;
    limit: number;
    maxCharacters: number;
    captureBoundary?: boolean;
    selection?: ResultSourceSelection;
  },
) => Promise<{
  messages: { role: string; text: string; timestamp?: string }[];
  nextOffset: number | null;
  truncated?: boolean;
  boundary?: HistoryBoundary;
}>;

/** Small manifests have immutable revisions. Native histories and code remain at their owner. */
export class CompositionStore {
  private readonly db: DatabaseSync;

  constructor(directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, "composition.sqlite");
    this.db = new DatabaseSync(file);
    chmodSync(file, 0o600);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 3000;
      CREATE TABLE IF NOT EXISTS versions (
        kind TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL,
        data TEXT NOT NULL, PRIMARY KEY(kind, id, revision)
      );
      CREATE TABLE IF NOT EXISTS current (
        kind TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL,
        title TEXT NOT NULL, projectId TEXT, updatedAt TEXT NOT NULL,
        PRIMARY KEY(kind, id)
      );
      CREATE INDEX IF NOT EXISTS current_project ON current(kind, projectId, updatedAt DESC);
      CREATE TABLE IF NOT EXISTS operations (
        id TEXT PRIMARY KEY, digest TEXT NOT NULL, result TEXT NOT NULL
      );
    `);
  }

  close() {
    this.db.close();
  }

  private load(kind: Kind, id: string, revision?: number): Document | null {
    const row = (
      revision
        ? this.db
            .prepare("SELECT data FROM versions WHERE kind = ? AND id = ? AND revision = ?")
            .get(kind, id, revision)
        : this.db
            .prepare(`SELECT v.data FROM versions v JOIN current c
          ON v.kind = c.kind AND v.id = c.id AND v.revision = c.revision
          WHERE c.kind = ? AND c.id = ?`)
            .get(kind, id)
    ) as DataRow | undefined;
    if (!row) return null;
    return (kind === "session" ? compositionSession : compositionProject).parse(
      JSON.parse(row.data),
    );
  }

  hasSession(id: string): boolean {
    return Boolean(
      this.db.prepare("SELECT 1 FROM current WHERE kind = ? AND id = ?").get("session", id),
    );
  }

  read(id: string, revision?: number): CompositionSession {
    const value = this.load("session", id, revision) as CompositionSession | null;
    if (!value) throw new Error("Logical session or requested revision not found");
    return value;
  }

  readProject(id: string): CompositionProject {
    const value = this.load("project", id) as CompositionProject | null;
    if (!value) throw new Error("Project not found");
    return value;
  }

  private write(kind: Kind, raw: Document): Document {
    const value = (kind === "session" ? compositionSession : compositionProject).parse(raw);
    const data = JSON.stringify(value);
    if (Buffer.byteLength(data) > MAX_DOCUMENT_BYTES)
      throw new Error("Composition manifest is too large; use references for large context");
    this.db
      .prepare("INSERT INTO versions(kind,id,revision,data) VALUES(?,?,?,?)")
      .run(kind, value.id, value.revision, data);
    this.db
      .prepare(`INSERT INTO current(kind,id,revision,title,projectId,updatedAt) VALUES(?,?,?,?,?,?)
      ON CONFLICT(kind,id) DO UPDATE SET revision=excluded.revision,title=excluded.title,
      projectId=excluded.projectId,updatedAt=excluded.updatedAt`)
      .run(
        kind,
        value.id,
        value.revision,
        value.title,
        "projectId" in value && typeof value.projectId === "string" ? value.projectId : null,
        value.updatedAt,
      );
    return value;
  }

  private operation<T>(
    method: string,
    input: { operationId: string; forwarded?: boolean },
    action: () => T,
  ): T {
    const digest = requestDigest(method, input);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db
        .prepare("SELECT digest,result FROM operations WHERE id=?")
        .get(input.operationId) as { digest: string; result: string } | undefined;
      if (existing) {
        if (existing.digest !== digest)
          throw new Error("Operation ID was already used for a different request");
        const result = JSON.parse(existing.result) as T;
        this.db.exec("COMMIT");
        return result;
      }
      const result = action();
      this.db
        .prepare("INSERT INTO operations(id,digest,result) VALUES(?,?,?)")
        .run(input.operationId, digest, JSON.stringify(result));
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private checkRevision(document: { revision: number }, expected: number) {
    if (document.revision !== expected)
      throw new Error(
        `Revision conflict: current revision is ${document.revision}. Reload before changing this session.`,
      );
  }

  saveProject(raw: z.input<typeof saveCompositionProject.input>): CompositionProject {
    const input = saveCompositionProject.input.parse(raw);
    return this.operation("project.save", input, () => {
      const current = this.load("project", input.id);
      this.checkRevision(current ?? { revision: 0 }, input.expectedRevision);
      return this.write("project", {
        id: input.id,
        title: input.title,
        memory: input.memory,
        resources: input.resources,
        revision: input.expectedRevision + 1,
        updatedAt: new Date().toISOString(),
      }) as CompositionProject;
    });
  }

  create(raw: z.input<typeof createComposition.input>): CompositionSession {
    const input = createComposition.input.parse(raw);
    return this.operation("create", input, () => {
      this.readProject(input.projectId);
      const now = new Date().toISOString();
      const value: CompositionSession = {
        id: randomUUID(),
        projectId: input.projectId,
        title: input.title,
        revision: 1,
        createdAt: now,
        updatedAt: now,
        memory: input.memory,
        resources: input.resources,
        endpoints: [],
        activeEndpointId: null,
        parent: null,
      };
      if (input.endpoint) this.attachEndpoint(value, input.endpoint);
      return this.write("session", value) as CompositionSession;
    });
  }

  update(raw: z.input<typeof updateComposition.input>): CompositionSession {
    const input = updateComposition.input.parse(raw);
    return this.operation("update", input, () => {
      const current = this.read(input.id);
      this.checkRevision(current, input.expectedRevision);
      return this.write("session", {
        ...current,
        title: input.title,
        memory: input.memory,
        resources: input.resources,
        revision: current.revision + 1,
        updatedAt: new Date().toISOString(),
      }) as CompositionSession;
    });
  }

  private attachEndpoint(
    session: CompositionSession,
    input: Omit<CompositionEndpoint, "id" | "createdAt">,
  ) {
    const existing = session.endpoints.find(
      (item) =>
        item.serverId === input.serverId &&
        item.agentId === input.agentId &&
        item.kind === input.kind,
    );
    if (existing && (existing.provider !== input.provider || existing.cwd !== input.cwd))
      throw new Error(
        "The native endpoint is already bound with a different provider or workspace",
      );
    const endpoint: CompositionEndpoint = {
      ...input,
      id: existing?.id ?? randomUUID(),
      createdAt: existing?.createdAt ?? new Date().toISOString(),
    };
    session.endpoints = [...session.endpoints.filter((item) => item.id !== endpoint.id), endpoint];
    session.activeEndpointId = endpoint.id;
    if (input.kind !== "agent") return;
    const historyId = `native-${createHash("sha256").update(`${input.serverId}\0${input.agentId}`).digest("hex").slice(0, 24)}`;
    if (!session.resources.some((item) => item.id === historyId))
      session.resources.push({
        id: historyId,
        kind: "history",
        label: `${input.provider} conversation`,
        serverId: input.serverId,
        connection: input.connection,
        format: "native-timeline",
        locator: input.agentId,
        readOnly: true,
      });
  }

  bind(raw: z.input<typeof bindComposition.input>): CompositionSession {
    const input = bindComposition.input.parse(raw);
    return this.operation("bind", input, () => {
      const current = this.read(input.id);
      this.checkRevision(current, input.expectedRevision);
      this.attachEndpoint(current, input.endpoint);
      return this.write("session", {
        ...current,
        revision: current.revision + 1,
        updatedAt: new Date().toISOString(),
      }) as CompositionSession;
    });
  }

  fork(
    raw: z.input<typeof forkComposition.input>,
    historyBoundaries: Record<string, HistoryBoundary> = {},
  ): CompositionSession {
    const input = forkComposition.input.parse(raw);
    return this.operation("fork", input, () => {
      const source = this.read(input.id);
      this.checkRevision(source, input.expectedRevision);
      if (this.ancestry(source).length >= MAX_COMPOSITION_ANCESTRY)
        throw new Error(
          `Fork lineage exceeds ${MAX_COMPOSITION_ANCESTRY} levels; start a new session with explicit references`,
        );
      const now = new Date().toISOString();
      const value: CompositionSession = {
        id: randomUUID(),
        projectId: source.projectId,
        title: input.title,
        revision: 1,
        createdAt: now,
        updatedAt: now,
        memory: "",
        resources: [],
        endpoints: [],
        activeEndpointId: null,
        parent: {
          sessionId: source.id,
          revision: source.revision,
          shareMemory: input.shareMemory,
          shareKinds: input.shareKinds,
          historyBoundaries,
        },
      };
      if (input.endpoint) this.attachEndpoint(value, input.endpoint);
      return this.write("session", value) as CompositionSession;
    });
  }

  private ancestry(session: CompositionSession): CompositionSession[] {
    const result: CompositionSession[] = [];
    const seen = new Set<string>();
    let current: CompositionSession | null = session;
    while (current) {
      if (result.length >= MAX_COMPOSITION_ANCESTRY || seen.has(current.id))
        throw new Error("Invalid or excessively deep session lineage");
      seen.add(current.id);
      result.push(current);
      current = current.parent
        ? this.read(current.parent.sessionId, current.parent.revision)
        : null;
    }
    return result;
  }

  replayFork(raw: z.input<typeof forkComposition.input>): CompositionSession | null {
    const input = forkComposition.input.parse(raw);
    const result = this.db
      .prepare("SELECT digest,result FROM operations WHERE id=?")
      .get(input.operationId) as { digest: string; result: string } | undefined;
    if (!result) return null;
    if (result.digest !== requestDigest("fork", input))
      throw new Error("Operation ID was already used for a different request");
    return compositionSession.parse(JSON.parse(result.result));
  }

  forkReferences(raw: z.input<typeof forkComposition.input>) {
    const input = forkComposition.input.parse(raw);
    const { session, references } = this.resolved(input.id);
    this.checkRevision(session, input.expectedRevision);
    if (!input.shareKinds.includes("history")) return [];
    const histories = [...references.values()].filter(
      (resource) => resource.kind === "history" && resource.inheritedFrom !== session.projectId,
    );
    if (histories.length > 100)
      throw new Error("Too many history references for a bounded fork; select fewer histories");
    return histories.map(({ inheritedFrom: _source, ...resource }) => resource);
  }

  list(raw: z.input<typeof listComposition.input>) {
    const input = listComposition.input.parse(raw);
    const query = `%${input.query.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
    const filter =
      "c.kind='session' AND (? IS NULL OR c.projectId=?) AND (c.title LIKE ? ESCAPE '\\' OR c.id LIKE ? ESCAPE '\\')";
    const params = [input.projectId ?? null, input.projectId ?? null, query, query];
    const rows = this.db
      .prepare(`SELECT v.data FROM current c JOIN versions v
      ON v.kind=c.kind AND v.id=c.id AND v.revision=c.revision WHERE ${filter}
      ORDER BY c.updatedAt DESC,c.id LIMIT ? OFFSET ?`)
      .all(...params, input.limit, input.offset) as DataRow[];
    const total = this.db
      .prepare(`SELECT COUNT(*) AS count FROM current c WHERE ${filter}`)
      .get(...params) as { count: number };
    const projectRows = this.db
      .prepare(`SELECT v.data FROM current c JOIN versions v
      ON v.kind=c.kind AND v.id=c.id AND v.revision=c.revision WHERE c.kind='project'
      ORDER BY c.updatedAt DESC,c.id LIMIT 100`)
      .all() as DataRow[];
    const summarize = <T extends { memory: string; resources: CompositionResource[] }>(
      value: T,
    ) => {
      const { memory, resources, ...summary } = value;
      return { ...summary, resourceCount: resources.length, memoryCharacters: memory.length };
    };
    return {
      projects: projectRows.map((row) => summarize(compositionProject.parse(JSON.parse(row.data)))),
      sessions: rows.map((row) => summarize(compositionSession.parse(JSON.parse(row.data)))),
      total: Number(total.count),
    };
  }

  private resolved(id: string, revision?: number) {
    const session = this.read(id, revision);
    const project = this.readProject(session.projectId);
    const lineage = this.ancestry(session);
    const memory: { source: string; text: string }[] = [];
    const references = new Map<string, CompositionResource & { inheritedFrom: string }>();
    let shareMemory = true;
    let kinds: Set<CompositionResource["kind"]> | null = null;
    const historyBoundaries = new Map<string, HistoryBoundary>();
    for (const entry of lineage) {
      if (shareMemory && entry.memory) memory.push({ source: entry.id, text: entry.memory });
      for (const resource of entry.resources) {
        if ((!kinds || kinds.has(resource.kind)) && !references.has(resource.id))
          references.set(resource.id, {
            ...resource,
            boundary: historyBoundaries.get(resource.id) ?? resource.boundary,
            inheritedFrom: entry.id,
          });
      }
      if (entry.parent) {
        for (const [resourceId, boundary] of Object.entries(entry.parent.historyBoundaries))
          if (!historyBoundaries.has(resourceId)) historyBoundaries.set(resourceId, boundary);
        shareMemory &&= entry.parent.shareMemory;
        const allowed: CompositionResource["kind"][] = entry.parent.shareKinds;
        kinds = new Set(allowed.filter((kind) => !kinds || kinds.has(kind)));
      }
    }
    // Project settings intentionally remain live across all sessions and branches.
    if (project.memory) memory.push({ source: project.id, text: project.memory });
    for (const resource of project.resources)
      if (!references.has(resource.id))
        references.set(resource.id, { ...resource, inheritedFrom: project.id });
    return { session, project, lineage, memory, references };
  }

  context(raw: z.input<typeof readCompositionContext.input>) {
    const input = readCompositionContext.input.parse(raw);
    const { session, project, lineage, memory, references } = this.resolved(
      input.id,
      input.revision,
    );
    let remaining = input.maxCharacters;
    let truncated = false;
    const memories: { source: string; text: string }[] = [];
    for (const item of memory) {
      if (item.text.length > remaining) truncated = true;
      if (remaining > 0) memories.push({ ...item, text: item.text.slice(0, remaining) });
      remaining = Math.max(0, remaining - item.text.length);
    }
    const resources = [...references.values()].slice(0, input.maxResources);
    truncated ||= references.size > resources.length;
    const continuation = [
      `FamiliarAgent logical session: ${session.title} (${session.id}, revision ${session.revision}).`,
      "Keep native tools in control. Shared notes below are user-maintained context. History and files remain at their source; fetch only needed references.",
      ...memories.map((item) => `Shared memory [${item.source}]:\n${item.text}`),
      "Available references:",
      ...resources.map(
        (item) =>
          `${item.id} | ${item.kind} | ${item.label} | host=${item.serverId} | ${item.locator}`,
      ),
    ].join("\n\n");
    const { memory: projectMemory, resources: projectResources, ...projectSummary } = project;
    return {
      sessionId: session.id,
      revision: session.revision,
      project: {
        ...projectSummary,
        memoryCharacters: projectMemory.length,
        resourceCount: projectResources.length,
      },
      lineage: lineage.map((item) => ({ sessionId: item.id, revision: item.revision })),
      memories,
      resources,
      truncated: truncated || continuation.length > input.maxCharacters,
      continuation: continuation.slice(0, input.maxCharacters),
    };
  }

  async readResource(raw: z.input<typeof readCompositionResource.input>, reader: ResourceReader) {
    const input = readCompositionResource.input.parse(raw);
    const resource = this.locateResource(input.id, input.resourceId, input.revision);
    const page = await reader(resource, input);
    let remaining = input.maxCharacters;
    let truncated = page.truncated ?? false;
    const messages: { role: string; text: string; timestamp?: string }[] = [];
    for (const message of page.messages.slice(0, input.limit)) {
      if (message.text.length > remaining) truncated = true;
      if (remaining === 0) break;
      messages.push({ ...message, text: message.text.slice(0, remaining) });
      remaining = Math.max(0, remaining - message.text.length);
    }
    truncated ||= page.messages.length > messages.length;
    // A caller can revisit a truncated message with a larger character budget.
    const nextOffset = page.nextOffset;
    return {
      resource: { ...resource, boundary: page.boundary ?? resource.boundary },
      messages,
      offset: input.offset,
      nextOffset,
      truncated,
    };
  }

  locateResource(id: string, resourceId: string, revision?: number): CompositionResource {
    const { references } = this.resolved(id, revision);
    const match = references.get(resourceId);
    if (!match) throw new Error("Resource is not shared with this logical session");
    const { inheritedFrom: _inheritedFrom, ...resource } = match;
    return resource;
  }
}
