import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { z } from "zod";
import {
  compositionInput,
  compositionResult,
  prepareCompositionInput,
  finishCompositionInput,
  type CompositionInput,
  type CompositionResult,
  type ResultAnchor,
} from "../../shared/results.js";
import type { CompositionSession, CompositionEndpoint } from "../../shared/composition.js";
import { renderResultInput, textDigest } from "./result-text.js";

type Prepare = z.infer<typeof prepareCompositionInput.input>;
interface Row {
  data: string;
  digest: string;
  token: string | null;
}
function digestRequest(raw: Prepare) {
  const { forwarded: _forwarded, ...input } = raw;
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

/** Small immutable result pointers and separately revised delivery receipts, never transcript copies. */
export class ResultStore {
  private readonly db: DatabaseSync;
  constructor(
    directory: string,
    private readonly session: (id: string) => CompositionSession,
    private readonly acceptsResult: (toolId: string, action: string) => boolean = () => false,
  ) {
    this.db = new DatabaseSync(path.join(directory, "composition.sqlite"));
    this.db.exec(`PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS composition_results(id TEXT PRIMARY KEY,sessionId TEXT NOT NULL,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS composition_inputs(id TEXT PRIMARY KEY,sessionId TEXT NOT NULL,createdAt TEXT NOT NULL,data TEXT NOT NULL,digest TEXT NOT NULL,token TEXT);
      CREATE INDEX IF NOT EXISTS composition_inputs_session ON composition_inputs(sessionId,createdAt DESC,id);
    `);
  }
  close() {
    this.db.close();
  }
  private transaction<T>(action: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = action();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  private row(id: string, inputId: string): Row {
    const row = this.db
      .prepare("SELECT data,digest,token FROM composition_inputs WHERE id=? AND sessionId=?")
      .get(inputId, id) as unknown as Row | undefined;
    if (!row) throw new Error("Input is not part of this logical session");
    return row;
  }
  result(id: string, resultId: string): CompositionResult {
    const row = this.db
      .prepare("SELECT data FROM composition_results WHERE id=? AND sessionId=?")
      .get(resultId, id) as { data: string } | undefined;
    if (!row) throw new Error("Result is not part of this logical session");
    return compositionResult.parse(JSON.parse(row.data));
  }
  read(id: string, inputId: string) {
    this.session(id);
    const input = compositionInput.parse(JSON.parse(this.row(id, inputId).data));
    return { input, result: this.result(id, input.resultId) };
  }
  list(id: string, offset: number, limit: number) {
    this.session(id);
    const rows = this.db
      .prepare(
        "SELECT id FROM composition_inputs WHERE sessionId=? ORDER BY createdAt DESC,id LIMIT ? OFFSET ?",
      )
      .all(id, limit, offset) as { id: string }[];
    const total = this.db
      .prepare("SELECT count(*) AS count FROM composition_inputs WHERE sessionId=?")
      .get(id) as { count: number };
    return { records: rows.map((row) => this.read(id, row.id)), total: total.count };
  }
  replay(raw: Prepare) {
    const row = this.db
      .prepare("SELECT data,digest,token FROM composition_inputs WHERE id=?")
      .get(raw.operationId) as unknown as Row | undefined;
    if (!row) return null;
    if (row.digest !== digestRequest(raw))
      throw new Error("Operation ID was already used for a different result input");
    return this.read(raw.id, raw.operationId);
  }
  plan(raw: Prepare): ResultAnchor {
    const session = this.session(raw.id);
    if (session.revision !== raw.expectedRevision)
      throw new Error("Logical session changed; reload before preparing this input");
    const source = session.endpoints.find((endpoint) => endpoint.id === raw.sourceEndpointId);
    const target = session.endpoints.find((endpoint) => endpoint.id === raw.targetEndpointId);
    if (
      !source ||
      !target ||
      !["agent", "tool"].includes(source.kind) ||
      !["agent", "tool"].includes(target.kind)
    )
      throw new Error(
        "Source and target must be native agents or tools linked to this same logical session",
      );
    if ((target.kind === "tool") !== !!raw.tool)
      throw new Error("Tool destinations require an explicit native action");
    if (raw.tool && !this.acceptsResult(target.provider, raw.tool.action))
      throw new Error(
        "This native action does not accept composed prompts. Use its original action form for exact commands or file data.",
      );
    const resource = raw.anchor.resource;
    if (resource.kind !== "history" || resource.serverId !== source.serverId || !resource.readOnly)
      throw new Error("Result source does not match the linked source endpoint");
    validateResultSource(source, resource, raw.id);
    // Connection addresses come from the linked endpoint, never an untrusted captured descriptor.
    return { ...raw.anchor, resource: { ...resource, connection: source.connection } };
  }
  prepare(raw: Prepare, selectedText: string) {
    return this.transaction(() => {
      const previous = this.replay(raw);
      if (previous) return previous;
      const anchor = this.plan(raw);
      const session = this.session(raw.id);
      const target = session.endpoints.find((endpoint) => endpoint.id === raw.targetEndpointId)!;
      const prompt = renderResultInput(anchor, selectedText, raw.instruction);
      const now = new Date().toISOString();
      const result = compositionResult.parse({
        id: randomUUID(),
        sessionId: raw.id,
        sourceEndpointId: raw.sourceEndpointId,
        createdAt: now,
        anchor,
        preview: selectedText.slice(0, 240),
      });
      const input = compositionInput.parse({
        id: raw.operationId,
        sessionId: raw.id,
        resultId: result.id,
        targetEndpointId: target.id,
        targetServerId: target.serverId,
        targetAgentId: target.agentId,
        ...(raw.tool ? { tool: { ...raw.tool, toolId: target.provider, cwd: target.cwd } } : {}),
        instruction: raw.instruction,
        inputSha256: textDigest(prompt).sha256,
        state: "prepared",
        revision: 1,
        createdAt: now,
        updatedAt: now,
        error: null,
      });
      this.db
        .prepare("INSERT INTO composition_results(id,sessionId,data) VALUES(?,?,?)")
        .run(result.id, raw.id, JSON.stringify(result));
      this.db
        .prepare(
          "INSERT INTO composition_inputs(id,sessionId,createdAt,data,digest) VALUES(?,?,?,?,?)",
        )
        .run(input.id, raw.id, now, JSON.stringify(input), digestRequest(raw));
      return { result, input };
    });
  }
  private target(input: CompositionInput, serverId: string, agentId = input.targetAgentId) {
    const endpoint = this.session(input.sessionId).endpoints.find(
      (candidate) => candidate.id === input.targetEndpointId,
    );
    if (
      !endpoint ||
      endpoint.kind !== (input.tool ? "tool" : "agent") ||
      (input.tool &&
        (endpoint.provider !== input.tool.toolId || endpoint.cwd !== input.tool.cwd)) ||
      endpoint.serverId !== serverId ||
      endpoint.agentId !== agentId ||
      input.targetServerId !== serverId ||
      input.targetAgentId !== agentId
    )
      throw new Error("Input belongs to a different target server or native agent");
  }
  claim(id: string, inputId: string, serverId: string) {
    return this.transaction(() => {
      const record = this.read(id, inputId);
      this.target(record.input, serverId);
      const row = this.row(id, inputId);
      if (record.input.state !== "prepared")
        return { ...record, claimed: false, ...(row.token ? { token: row.token } : {}) };
      const token = randomUUID();
      const input = {
        ...record.input,
        state: "unknown" as const,
        revision: record.input.revision + 1,
        updatedAt: new Date().toISOString(),
      };
      this.db
        .prepare("UPDATE composition_inputs SET data=?,token=? WHERE id=?")
        .run(JSON.stringify(input), token, inputId);
      return { result: record.result, input, claimed: true, token };
    });
  }
  finish(raw: z.infer<typeof finishCompositionInput.input>) {
    return this.transaction(() => {
      const record = this.read(raw.id, raw.inputId);
      this.target(record.input, raw.targetServerId, raw.targetAgentId);
      if (this.row(raw.id, raw.inputId).token !== raw.token)
        throw new Error("Input dispatch claim does not match this attempt");
      if (record.input.state === "accepted" || record.input.state === "failed") return record;
      const input = compositionInput.parse({
        ...record.input,
        state: raw.state,
        error: raw.error,
        revision: record.input.revision + 1,
        updatedAt: new Date().toISOString(),
      });
      this.db
        .prepare("UPDATE composition_inputs SET data=? WHERE id=?")
        .run(JSON.stringify(input), input.id);
      return { result: record.result, input };
    });
  }
}

function validateResultSource(
  source: CompositionEndpoint,
  resource: ResultAnchor["resource"],
  sessionId: string,
) {
  if (source.kind === "tool") {
    if (
      resource.format !== "tool-result" ||
      resource.boundary?.kind !== "tool" ||
      resource.boundary.toolId !== source.provider ||
      resource.boundary.cwd !== source.cwd ||
      resource.boundary.sessionId !== sessionId
    )
      throw new Error("Native tool result does not match this source endpoint and logical session");
  } else {
    if (resource.format !== "native-timeline" || resource.locator !== source.agentId)
      throw new Error("Result source does not match the linked source endpoint");
    if (
      resource.boundary?.kind !== "native" ||
      !resource.boundary.transcript ||
      resource.boundary.transcript.source.toLowerCase() !== source.provider
    )
      throw new Error("Result source provider or persistent boundary does not match its endpoint");
  }
}
