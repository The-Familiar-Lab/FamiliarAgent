import { createHash } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { toolRun, type ToolRun, type ToolRunSummary } from "../../shared/tool-actions.js";
import type { ToolActionRequest, ToolActionResult } from "./contracts.js";

export function requestDigest(request: ToolActionRequest): string {
  const ordered = {
    toolId: request.toolId,
    action: request.action,
    cwd: request.cwd,
    sessionId: request.sessionId,
    input: request.input,
    nativeId: request.nativeId,
    parameters: Object.fromEntries(
      Object.entries(request.parameters).sort(([a], [b]) => a.localeCompare(b)),
    ),
  };
  return createHash("sha256").update(JSON.stringify(ordered)).digest("hex");
}
export function resultDigest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
export class ToolRunStore {
  private readonly db: DatabaseSync;
  constructor(
    private readonly directory: string,
    private readonly serverId: string,
  ) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, "runs.sqlite");
    this.db = new DatabaseSync(file);
    chmodSync(file, 0o600);
    this.db.exec(`PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS tool_runs(id TEXT PRIMARY KEY,sessionId TEXT NOT NULL,createdAt TEXT NOT NULL,scope TEXT,state TEXT NOT NULL,digest TEXT NOT NULL,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS tool_runs_session ON tool_runs(sessionId,createdAt DESC,id);
      CREATE UNIQUE INDEX IF NOT EXISTS tool_runs_busy ON tool_runs(scope) WHERE scope IS NOT NULL AND state IN ('running','unknown');`);
    const interrupted = this.db
      .prepare("SELECT data FROM tool_runs WHERE state='running'")
      .all() as { data: string }[];
    for (const row of interrupted) {
      const run = toolRun.parse(JSON.parse(row.data));
      this.finish(
        run.id,
        "unknown",
        null,
        "FamiliarAgent restarted while this action was running. Check the original tool before retrying.",
      );
    }
  }
  close() {
    this.db.close();
  }
  runDirectory(id: string) {
    return path.join(this.directory, "runs", id);
  }
  read(id: string): ToolRun {
    const row = this.db.prepare("SELECT data FROM tool_runs WHERE id=?").get(id) as
      | { data: string }
      | undefined;
    if (!row) throw new Error("Native tool run was not found on this server");
    return toolRun.parse(JSON.parse(row.data));
  }
  replay(id: string, request: ToolActionRequest): ToolRun | null {
    const row = this.db.prepare("SELECT digest FROM tool_runs WHERE id=?").get(id) as
      | { digest: string }
      | undefined;
    if (!row) return null;
    if (row.digest !== requestDigest(request))
      throw new Error("Operation ID already belongs to a different native action");
    return this.read(id);
  }
  create(id: string, request: ToolActionRequest, mutates: boolean): ToolRun {
    const now = new Date().toISOString();
    const run = toolRun.parse({
      id,
      serverId: this.serverId,
      request,
      state: "running",
      createdAt: now,
      updatedAt: now,
      result: null,
      resultSha256: null,
      error: null,
    });
    const scope = mutates
      ? JSON.stringify([request.toolId, request.nativeId ?? request.cwd])
      : null;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (
        scope &&
        this.db
          .prepare("SELECT id FROM tool_runs WHERE scope=? AND state IN ('running','unknown')")
          .get(scope)
      )
        throw new Error(
          "This native workspace/session has a running or unresolved action. Check that action before sending another write.",
        );
      this.db
        .prepare(
          "INSERT INTO tool_runs(id,sessionId,createdAt,scope,state,digest,data) VALUES(?,?,?,?,?,?,?)",
        )
        .run(
          id,
          request.sessionId,
          now,
          scope,
          run.state,
          requestDigest(request),
          JSON.stringify(run),
        );
      this.db.exec("COMMIT");
      return run;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  finish(
    id: string,
    state: ToolRun["state"],
    result: ToolActionResult | null,
    error: string | null,
  ): ToolRun {
    const previous = this.read(id);
    const run = toolRun.parse({
      ...previous,
      state,
      result,
      resultSha256: result ? resultDigest(result.text) : null,
      error,
      updatedAt: new Date().toISOString(),
    });
    this.db
      .prepare("UPDATE tool_runs SET state=?,data=? WHERE id=?")
      .run(state, JSON.stringify(run), id);
    return run;
  }
  releaseUnknown(id: string, note: string): ToolRun {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare("SELECT scope FROM tool_runs WHERE id=?").get(id) as
        | { scope: string | null }
        | undefined;
      const previous = this.read(id);
      if (previous.state !== "unknown")
        throw new Error(
          "Only an unknown native action can be released after checking its original state",
        );
      if (row?.scope === null) {
        this.db.exec("COMMIT");
        return previous;
      }
      const error =
        `${previous.error ?? "Native outcome remains unknown."}\nOriginal state checked by user; execution scope released. Note: ${note}`.slice(
          -2000,
        );
      const run = toolRun.parse({ ...previous, error, updatedAt: new Date().toISOString() });
      this.db
        .prepare("UPDATE tool_runs SET scope=NULL,data=? WHERE id=?")
        .run(JSON.stringify(run), id);
      this.db.exec("COMMIT");
      return run;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  list(sessionId: string, offset: number, limit: number) {
    const rows = this.db
      .prepare(
        "SELECT data FROM tool_runs WHERE sessionId=? ORDER BY createdAt DESC,id LIMIT ? OFFSET ?",
      )
      .all(sessionId, limit, offset) as { data: string }[];
    const total = this.db
      .prepare("SELECT count(*) AS count FROM tool_runs WHERE sessionId=?")
      .get(sessionId) as { count: number };
    return {
      runs: rows.map((row) => summarizeToolRun(toolRun.parse(JSON.parse(row.data)))),
      total: total.count,
    };
  }
}
function summarizeToolRun(run: ToolRun): ToolRunSummary {
  const { request: fullRequest, result: fullResult, ...metadata } = run;
  const { input: _input, ...request } = fullRequest;
  if (!fullResult) return { ...metadata, request, result: null };
  const { text, ...result } = fullResult;
  return {
    ...metadata,
    request,
    result: { ...result, preview: text.slice(0, 1000), textBytes: Buffer.byteLength(text) },
  };
}
