import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  compositionBridgeCredential,
  ensureCompositionBridge,
  installCompositionBridge,
  readCompositionSource,
  type CompositionResource,
} from "../../shared/composition.js";
import { forwardWorkspace } from "../authority.js";
import { boundedSourceRead } from "./readers.js";
import type { ResourceReader } from "./store.js";
import { scopedCatalogCall, type CatalogInvoke } from "./catalog.js";

const MAX_REQUEST_BYTES = 32 * 1024;
const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_CATALOG_BYTES = 2 * 1024 * 1024;
const BRIDGE_TIMEOUT_MS = 20_000;
type Credential = z.infer<typeof compositionBridgeCredential>;
interface RunningBridge {
  target: string;
  token: string;
  resources: Set<string>;
  references: Map<string, CompositionResource>;
  sessions: Map<string, string | undefined>;
  server: Server;
  process: ChildProcess;
  port: number;
}
const resourceKey = (resource: CompositionResource) =>
  `${resource.serverId}\0${resource.format}\0${resource.locator}`;

/** A tool result is shareable only while its owning store verifies the frozen record. */
export async function validateBridgeResources(
  resources: CompositionResource[],
  reader: ResourceReader,
) {
  for (const resource of resources) {
    if (
      resource.kind !== "history" ||
      !["native-timeline", "imported-history", "tool-result"].includes(resource.format ?? "")
    )
      throw new Error(
        "Only native history, imported history or completed tool result references can be shared through a context connection",
      );
    if (resource.format !== "tool-result") continue;
    const expected = resource.boundary;
    if (!resource.readOnly || expected?.kind !== "tool")
      throw new Error("Shared tool results require an immutable source boundary");
    const { boundary } = await reader(resource, { offset: 0, limit: 1, maxCharacters: 256 });
    if (
      boundary?.kind !== "tool" ||
      boundary.toolId !== expected.toolId ||
      boundary.cwd !== expected.cwd ||
      boundary.sessionId !== expected.sessionId ||
      boundary.sha256 !== expected.sha256
    )
      throw new Error("Shared tool result no longer matches its owning source");
  }
}

function sshArguments(target: string, localPort: number) {
  const address = new URL(target);
  if (
    address.protocol !== "ssh:" ||
    address.password ||
    address.hash ||
    (address.pathname && address.pathname !== "/") ||
    address.hostname.startsWith("-")
  )
    throw new Error("Return path requires an SSH URI without a password or path");
  const user = decodeURIComponent(address.username);
  if (user && !/^[\w.-]+$/u.test(user)) throw new Error("Invalid SSH user");
  return [
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "ServerAliveInterval=20",
    "-o",
    "ServerAliveCountMax=3",
    "-N",
    "-v",
    "-R",
    `127.0.0.1:0:127.0.0.1:${localPort}`,
    ...(address.port ? ["-p", address.port] : []),
    ...(user ? ["-l", user] : []),
    address.hostname,
  ];
}

function authorize(header: string | undefined, token: string) {
  const expected = Buffer.from(`Bearer ${token}`);
  const actual = Buffer.from(header ?? "");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** Exposes scoped history, session memory and input receipts; never native execution or the filesystem. */
export async function startReadOnlyBridge(options: {
  token: string;
  resources: Set<string>;
  reader: ResourceReader;
  sessions?: Map<string, string | undefined>;
  catalog?: CatalogInvoke;
  targetServerId?: string;
}): Promise<{ server: Server; port: number }> {
  const server = createServer(
    { maxHeaderSize: 8192, requestTimeout: BRIDGE_TIMEOUT_MS },
    async (request, response) => {
      const catalogRequest = request.url === "/catalog" && options.catalog && options.sessions;
      if (request.method !== "POST" || (request.url !== "/history" && !catalogRequest)) {
        response.writeHead(404).end();
        return;
      }
      if (!authorize(request.headers.authorization, options.token)) {
        response.writeHead(401).end();
        return;
      }
      try {
        let size = 0;
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
          size += chunk.length;
          if (size > (catalogRequest ? MAX_CATALOG_BYTES : MAX_REQUEST_BYTES)) {
            response.writeHead(413).end();
            return;
          }
          chunks.push(Buffer.from(chunk));
        }
        const raw: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        let result: unknown;
        if (catalogRequest) {
          result = await scopedCatalogCall(
            raw,
            options.sessions!,
            options.catalog!,
            options.targetServerId,
          );
        } else {
          const { resource, ...input } = readCompositionSource.input.parse(raw);
          if (!options.resources.has(resourceKey(resource))) {
            response.writeHead(403).end();
            return;
          }
          result = await boundedSourceRead(resource, input, options.reader);
        }
        const body = JSON.stringify(result);
        if (Buffer.byteLength(body) > (catalogRequest ? MAX_CATALOG_BYTES : MAX_RESPONSE_BYTES))
          throw new Error("Context exceeds bridge response limit");
        response
          .writeHead(200, { "content-type": "application/json", "cache-control": "no-store" })
          .end(body);
      } catch (error) {
        response
          .writeHead(400, { "content-type": "application/json", "cache-control": "no-store" })
          .end(
            JSON.stringify({
              error: error instanceof Error ? error.message : "Source read failed",
            }),
          );
      }
    },
  );
  server.headersTimeout = BRIDGE_TIMEOUT_MS;
  server.keepAliveTimeout = 1000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Cannot allocate private history bridge");
  return { server, port: address.port };
}

async function requestBridge(credential: Credential, route: "history" | "catalog", input: unknown) {
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${credential.port}/${route}`, {
      method: "POST",
      headers: { authorization: `Bearer ${credential.token}`, "content-type": "application/json" },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(BRIDGE_TIMEOUT_MS),
      redirect: "error",
    });
  } catch {
    throw new Error(
      "Session context connection is offline; reconnect the source server and open this session in FamiliarAgent",
    );
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Session context connection returned an empty response");
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > (route === "catalog" ? MAX_CATALOG_BYTES : MAX_RESPONSE_BYTES))
        throw new Error("Session context connection exceeded the response limit");
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel();
  }
  const body = Buffer.concat(chunks).toString("utf8");
  if (!response.ok) {
    let detail = "";
    try {
      const value = JSON.parse(body) as { error?: unknown };
      if (typeof value.error === "string") detail = `: ${value.error.slice(0, 1024)}`;
    } catch {
      /* Empty authentication errors contain no JSON. */
    }
    throw new Error(
      `Session context connection failed (${response.status})${detail}; reconnect the source server and open this session in FamiliarAgent`,
    );
  }
  return JSON.parse(body) as unknown;
}

/** Private receiving-host registry; capability tokens never enter project/session manifests. */
export class BridgeRegistry {
  constructor(
    private readonly directory: string,
    private readonly serverId: string,
  ) {}
  private file(source: string) {
    return path.join(this.directory, `${createHash("sha256").update(source).digest("hex")}.json`);
  }
  async install(raw: z.input<typeof compositionBridgeCredential>) {
    const credential = compositionBridgeCredential.parse(raw);
    if (credential.targetServerId !== this.serverId)
      throw new Error("Return path was prepared for a different server");
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await this.save(this.file(credential.sourceServerId), credential);
    for (const owner of credential.resourceServerIds) await this.save(this.file(owner), credential);
    for (const sessionId of credential.sessions)
      await this.save(this.file(`session:${sessionId}`), credential);
  }
  private async save(file: string, credential: Credential) {
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(credential), { mode: 0o600, flag: "wx" });
      await rename(temporary, file);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  async catalog(sessionId: string): Promise<CatalogInvoke | null> {
    let raw: string;
    try {
      raw = await readFile(this.file(`session:${sessionId}`), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    const credential = compositionBridgeCredential.parse(JSON.parse(raw));
    if (credential.targetServerId !== this.serverId || !credential.sessions.includes(sessionId))
      throw new Error("Stored session context connection belongs to a different session or server");
    return (method, input) => {
      if (input.id !== sessionId) throw new Error("Session is outside this context link");
      return requestBridge(credential, "catalog", { method, input });
    };
  }
  async reader(resource: CompositionResource): Promise<ResourceReader | null> {
    let raw: string;
    try {
      raw = await readFile(this.file(resource.serverId), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    const credential = compositionBridgeCredential.parse(JSON.parse(raw));
    if (
      (credential.sourceServerId !== resource.serverId &&
        !credential.resourceServerIds.includes(resource.serverId)) ||
      credential.targetServerId !== this.serverId
    )
      throw new Error("Stored history return path belongs to a different server");
    return async (reference, input) => {
      const result = readCompositionSource.output.parse(
        await requestBridge(credential, "history", { resource: reference, ...input }),
      );
      if (resourceKey(result.resource) !== resourceKey(reference))
        throw new Error("History return path returned a different source");
      return {
        messages: result.messages,
        nextOffset: result.nextOffset,
        truncated: result.truncated,
        boundary: result.resource.boundary,
      };
    };
  }
}

/** Source owns the SSH child. Losing it only disables lazy reads; native work continues. */
export class CompositionBridges {
  private readonly bridges = new Map<string, RunningBridge>();
  private readonly pending = new Map<
    string,
    Promise<z.infer<typeof ensureCompositionBridge.output>>
  >();
  private closed = false;
  private readonly restoring = new Set<string>();
  constructor(
    private readonly options: { serverId: string; cliPath?: string; leasesDirectory?: string },
  ) {}
  async ensure(
    raw: z.input<typeof ensureCompositionBridge.input>,
    reader: ResourceReader,
    catalog?: CatalogInvoke,
  ) {
    const input = ensureCompositionBridge.input.parse(raw);
    if (!input.resources.length && !input.sessions.length)
      throw new Error("Select at least one session or history reference to connect");
    if (input.sessions.length && !catalog)
      throw new Error("Session context routing is unavailable");
    if (input.catalogAuthority) sshArguments(input.catalogAuthority, 1);
    if (this.closed) throw new Error("History bridge service is closed");
    if (input.targetServerId === this.options.serverId)
      throw new Error("A return path is unnecessary on the same server");
    for (const resource of input.resources)
      if (resource.serverId !== this.options.serverId) {
        if (!resource.connection)
          throw new Error("Remote history requires an explicit SSH source connection");
        sshArguments(resource.connection, 1);
      }
    await validateBridgeResources(input.resources, reader);
    const previous = this.pending.get(input.targetServerId) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(() => this.prepare(input, reader, catalog));
    this.pending.set(input.targetServerId, task);
    try {
      return await task;
    } finally {
      if (this.pending.get(input.targetServerId) === task)
        this.pending.delete(input.targetServerId);
    }
  }
  private async prepare(
    input: z.infer<typeof ensureCompositionBridge.input>,
    reader: ResourceReader,
    catalog?: CatalogInvoke,
  ) {
    if (this.closed) throw new Error("History bridge service is closed");
    let bridge = this.bridges.get(input.targetServerId);
    if (
      bridge &&
      (bridge.process.exitCode !== null || bridge.process.killed || bridge.target !== input.target)
    ) {
      this.release(input.targetServerId, bridge);
      bridge = undefined;
    }
    if (!bridge) {
      const token = randomBytes(32).toString("hex");
      const resources = new Set(input.resources.map(resourceKey));
      const references = new Map(
        input.resources.map((resource) => [resourceKey(resource), resource]),
      );
      const sessions = new Map(input.sessions.map((id) => [id, input.catalogAuthority]));
      const { server, port } = await startReadOnlyBridge({
        token,
        resources,
        reader,
        sessions,
        catalog,
        targetServerId: input.targetServerId,
      });
      let child: ChildProcess | undefined;
      try {
        child = spawn("ssh", sshArguments(input.target, port), {
          stdio: ["ignore", "ignore", "pipe"],
          windowsHide: true,
        });
        const process = child;
        const remotePort = await new Promise<number>((resolve, reject) => {
          let buffer = "";
          const timer = setTimeout(
            () => finish(new Error("SSH history return path timed out")),
            BRIDGE_TIMEOUT_MS,
          );
          const onError = () => finish(new Error("Cannot start SSH history return path"));
          const onExit = () =>
            finish(new Error("SSH history return path could not be established"));
          const onData = (chunk: Buffer) => {
            buffer = (buffer + chunk.toString("utf8")).slice(-8192);
            const match = buffer.match(/Allocated port (\d+) for remote forward/u);
            if (match) finish(undefined, Number(match[1]));
          };
          const finish = (error?: Error, allocatedPort?: number) => {
            clearTimeout(timer);
            process.off("error", onError);
            process.off("exit", onExit);
            process.stderr?.off("data", onData);
            if (error) reject(error);
            else resolve(allocatedPort!);
          };
          process.once("error", onError);
          process.once("exit", onExit);
          process.stderr?.on("data", onData);
        });
        // Drain debug output without logging key paths, account names or tunnel credentials.
        process.stderr?.resume();
        bridge = {
          target: input.target,
          token,
          resources,
          references,
          sessions,
          server,
          process,
          port: remotePort,
        };
        this.bridges.set(input.targetServerId, bridge);
        const current = bridge;
        process.once("exit", () => this.release(input.targetServerId, current));
        if (this.closed) throw new Error("History bridge service closed during connection");
      } catch (error) {
        child?.kill();
        server.closeAllConnections();
        server.close();
        throw error;
      }
    }
    if (
      new Set([...bridge.resources, ...input.resources.map(resourceKey)]).size > 1000 ||
      new Set([...bridge.sessions.keys(), ...input.sessions]).size > 1000
    )
      throw new Error(
        "Too many session context references on this server; reconnect FamiliarAgent",
      );
    for (const resource of input.resources) {
      bridge.resources.add(resourceKey(resource));
      bridge.references.set(resourceKey(resource), resource);
    }
    for (const id of input.sessions) bridge.sessions.set(id, input.catalogAuthority);
    try {
      installCompositionBridge.output.parse(
        await forwardWorkspace(
          input.target,
          installCompositionBridge.name,
          {
            sourceServerId: this.options.serverId,
            targetServerId: input.targetServerId,
            port: bridge.port,
            token: bridge.token,
            sessions: [...bridge.sessions.keys()],
            resourceServerIds: [
              ...new Set([...bridge.references.values()].map((resource) => resource.serverId)),
            ],
          },
          this.options.cliPath,
        ),
      );
    } catch (error) {
      this.release(input.targetServerId, bridge);
      throw error;
    }
    await this.saveLease(input.targetServerId, bridge);
    return {
      sourceServerId: this.options.serverId,
      targetServerId: input.targetServerId,
      active: true as const,
      sharedReferences: bridge.resources.size,
      linkedSessions: bridge.sessions.size,
    };
  }
  private async saveLease(targetServerId: string, bridge: RunningBridge) {
    if (!this.options.leasesDirectory || this.restoring.has(targetServerId)) return;
    await mkdir(this.options.leasesDirectory, { recursive: true, mode: 0o700 });
    const file = path.join(
      this.options.leasesDirectory,
      `${createHash("sha256").update(targetServerId).digest("hex")}.json`,
    );
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(
        temporary,
        JSON.stringify({
          target: bridge.target,
          targetServerId,
          resources: [...bridge.references.values()],
          catalogs: [...bridge.sessions].map(([id, authority]) => ({ id, authority })),
        }),
        { mode: 0o600, flag: "wx" },
      );
      await rename(temporary, file);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  /** One bounded startup attempt per saved target. UI reconnect renews failed leases on demand. */
  async restore(reader: ResourceReader, catalog: CatalogInvoke) {
    if (!this.options.leasesDirectory) return { restored: 0, failed: 0 };
    const directory = this.options.leasesDirectory;
    let files: string[];
    try {
      files = await readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { restored: 0, failed: 0 };
      throw error;
    }
    const schema = z
      .object({
        target: ensureCompositionBridge.input.shape.target,
        targetServerId: ensureCompositionBridge.input.shape.targetServerId,
        resources: z.array(readCompositionSource.input.shape.resource).max(1000),
        catalogs: z
          .array(
            z.object({
              id: z.string().min(1).max(160),
              authority: z.string().max(4096).optional(),
            }),
          )
          .max(1000),
      })
      .strict();
    const result = { restored: 0, failed: 0 };
    const queue = files.filter((file) => /^[a-f0-9]{64}\.json$/u.test(file)).slice(0, 256);
    const restoreOne = async (file: string) => {
      try {
        const raw = await readFile(path.join(directory, file), "utf8");
        if (raw.length > MAX_CATALOG_BYTES) throw new Error("Stored context lease is too large");
        const saved = schema.parse(JSON.parse(raw));
        this.restoring.add(saved.targetServerId);
        try {
          // Multiple catalog authorities may be represented on one controller-to-target tunnel.
          const groups = new Map<string | undefined, string[]>();
          for (const route of saved.catalogs) {
            const ids = groups.get(route.authority) ?? [];
            ids.push(route.id);
            groups.set(route.authority, ids);
          }
          for (let offset = 0; offset < saved.resources.length; offset += 100)
            await this.ensure(
              {
                target: saved.target,
                targetServerId: saved.targetServerId,
                resources: saved.resources.slice(offset, offset + 100),
              },
              reader,
              catalog,
            );
          for (const [catalogAuthority, ids] of groups)
            for (let offset = 0; offset < ids.length; offset += 100)
              await this.ensure(
                {
                  target: saved.target,
                  targetServerId: saved.targetServerId,
                  sessions: ids.slice(offset, offset + 100),
                  catalogAuthority,
                },
                reader,
                catalog,
              );
        } finally {
          this.restoring.delete(saved.targetServerId);
        }
        const active = this.bridges.get(saved.targetServerId);
        if (active) await this.saveLease(saved.targetServerId, active);
        result.restored++;
      } catch {
        result.failed++;
      }
    };
    for (let offset = 0; offset < queue.length && !this.closed; offset += 2)
      await Promise.all(queue.slice(offset, offset + 2).map(restoreOne));
    return result;
  }
  private release(target: string, bridge: RunningBridge) {
    if (this.bridges.get(target) === bridge) this.bridges.delete(target);
    bridge.process.kill();
    bridge.server.closeAllConnections();
    bridge.server.close();
  }
  close() {
    this.closed = true;
    for (const [target, bridge] of this.bridges) this.release(target, bridge);
  }
}
