import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { z } from "zod";
import { createFamiliarCommandRunner, type FamiliarCommandRunner } from "./familiarCommandRunner.js";

const MAX_FRAME_BYTES = 24 * 1024 * 1024;
const MAX_PENDING = 32;
const HEARTBEAT_MS = 10000;
const LOST_CONNECTION_MS = 35000;
const methods = new Set(["composition.context", "composition.read", "tools.actions", "tools.runs.list", "tools.run.read", "tools.run.cancel", "tools.action-settings.read", "tools.run.start", "agent.status", "agent.permission", "space.read", "artifact.get", "artifact.put", "agent.send"]);
const requestSchema = z.object({ type: z.literal("request"), id: z.string().uuid(), args: z.array(z.string().max(16384)).max(16), timeoutMs: z.number().int().min(1).max(7230000), input: z.unknown().optional() }).strict();
export function validateRelayRequest(value: unknown) {
  const request = requestSchema.parse(value), args = request.args;
  const plugin = args.length === 9 && args[0] === "plugin" && args[1] === "call" && args[2] === "familiar-workspace" && methods.has(args[3]!) && args[4] === "--input-file" && args[6] === "--host" && args[8] === "--json" && Object.hasOwn(request, "input");
  const agent = args[0] === "agent" && /^[\w-]{1,160}$/.test(args[2] ?? "") && (
    (args.length === 6 && args[1] === "stop" && args[3] === "--host" && args[5] === "--json") ||
    (args.length === 8 && args[1] === "wait" && args[3] === "--timeout" && /^\d+s$/.test(args[4] ?? "") && args[5] === "--host" && args[7] === "--json")
  );
  if (!plugin && !agent) throw new Error("This command is not allowed through the Discord connection.");
  return request;
}
export function readRelayFrames(input: Readable, receive: (value: unknown) => void, close: (error: Error) => void): () => void {
  let buffer = Buffer.alloc(0);
  const data = (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > MAX_FRAME_BYTES) { close(new Error("Discord connection frame is too large.")); return; }
    let end: number;
    while ((end = buffer.indexOf(10)) !== -1) {
      const line = buffer.subarray(0, end).toString("utf8"); buffer = buffer.subarray(end + 1);
      if (line === "FAMILIAR_DISCORD_READY") continue;
      try { receive(JSON.parse(line)); } catch { close(new Error("Discord connection protocol failed.")); return; }
    }
  };
  const ended = () => close(new Error("Discord connection closed; pending native requests need inspection."));
  input.on("data", data); input.once("end", ended); input.once("close", ended); input.once("error", ended);
  return () => { input.off("data", data); input.off("end", ended); input.off("close", ended); input.off("error", ended); buffer = Buffer.alloc(0); };
}
function send(output: Writable, value: unknown): void {
  const line = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(line) > MAX_FRAME_BYTES || output.writableLength > MAX_FRAME_BYTES) throw new Error("Discord connection output is full.");
  output.write(line);
}
export function createFamiliarRelayRunner(input: Readable, output: Writable, disconnected: () => void): FamiliarCommandRunner & { close(): Promise<void> } {
  const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  let closed = false, lastSeen = Date.now();
  const close = () => {
    if (closed) return; closed = true; clearInterval(heartbeat); detach();
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error("Desktop connection closed; inspect the native session before retrying.")); } pending.clear(); disconnected();
  };
  const detach = readRelayFrames(input, value => {
    const frame = z.object({ type: z.enum(["response", "pong"]), id: z.string().optional(), result: z.unknown().optional(), error: z.string().optional() }).parse(value);
    lastSeen = Date.now(); if (frame.type === "pong") return;
    const item = pending.get(frame.id ?? ""); if (!item) return;
    pending.delete(frame.id!); clearTimeout(item.timer);
    if (frame.error) item.reject(new Error(frame.error)); else item.resolve(frame.result);
  }, close);
  const heartbeat = setInterval(() => { if (Date.now() - lastSeen > LOST_CONNECTION_MS) close(); else { try { send(output, { type: "ping" }); } catch { close(); } } }, HEARTBEAT_MS);
  const run: FamiliarCommandRunner = async (args, timeoutMs) => {
    if (closed || pending.size >= MAX_PENDING) throw new Error("Discord desktop connection is unavailable or busy.");
    const fileIndex = args.indexOf("--input-file");
    const payload = fileIndex === -1 ? {} : { input: JSON.parse(await readFile(args[fileIndex + 1]!, "utf8")) };
    if (closed || pending.size >= MAX_PENDING) throw new Error("Discord desktop connection is unavailable or busy.");
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error("Desktop request timed out; it will not be automatically resent.")); }, timeoutMs + 1000);
      pending.set(id, { resolve, reject, timer });
      try { send(output, validateRelayRequest({ type: "request", id, args, timeoutMs, ...payload })); }
      catch (error) { pending.delete(id); clearTimeout(timer); reject(error); }
    });
  };
  return Object.assign(run, { async close() { close(); } });
}
export async function serveFamiliarRelay(cliPath: string, input: Readable, output: Writable): Promise<void> {
  const runner = createFamiliarCommandRunner(cliPath);
  const tasks = new Set<Promise<void>>();
  await new Promise<void>((resolve, reject) => {
    let closed = false;
    const close = (error?: Error) => { if (closed) return; closed = true; detach(); void runner.close().then(() => Promise.allSettled([...tasks])).then(() => error ? reject(error) : resolve()); };
    const detach = readRelayFrames(input, value => {
      if (z.object({ type: z.literal("ping") }).safeParse(value).success) { send(output, { type: "pong" }); return; }
      const request = validateRelayRequest(value);
      if (tasks.size >= MAX_PENDING) { send(output, { type: "response", id: request.id, error: "Discord connector is busy." }); return; }
      const task = (async () => {
        let directory: string | undefined;
        try {
          const args = [...request.args];
          if (Object.hasOwn(request, "input")) {
            directory = await mkdtemp(path.join(os.tmpdir(), "familiar-discord-relay-"));
            const file = path.join(directory, "input.json"); await writeFile(file, JSON.stringify(request.input), { mode: 0o600 }); args[5] = file;
          }
          const result = await runner(args, request.timeoutMs); if (!closed) send(output, { type: "response", id: request.id, result });
        } catch (error) { if (!closed) send(output, { type: "response", id: request.id, error: error instanceof Error ? error.message : "Native request failed." }); }
        finally { if (directory) await rm(directory, { recursive: true, force: true }); }
      })();
      tasks.add(task); void task.finally(() => tasks.delete(task)).catch(() => close(new Error("Discord relay failed.")));
    }, () => close());
  });
}
