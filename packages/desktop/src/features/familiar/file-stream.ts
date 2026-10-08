import { randomUUID } from "node:crypto";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { dialog } from "electron";
import { z } from "zod";
import {
  createSshProxy,
  parseTransportTarget,
  type TransportTarget,
} from "../../daemon/local-transport.js";

const LEASE_MS = 30 * 60 * 1000;
const STREAM_TIMEOUT_MS = 30_000;
const leases = new Map<
  string,
  {
    target: TransportTarget | { transportType: "tcp"; endpoint: string };
    token: string;
    preview: boolean;
    expiresAt: number;
  }
>();
const inputSchema = z
  .object({ target: z.unknown(), token: z.string().uuid(), preview: z.boolean() })
  .strict();

export function registerFileStream(input: unknown): { url: string } {
  const parsed = inputSchema.parse(input);
  const tcp = z
    .object({
      transportType: z.literal("tcp"),
      endpoint: z
        .string()
        .url()
        .refine((value) => ["http:", "https:"].includes(new URL(value).protocol)),
    })
    .strict()
    .safeParse(parsed.target);
  const target = tcp.success ? tcp.data : parseTransportTarget(parsed.target);
  for (const [id, lease] of leases) if (lease.expiresAt <= Date.now()) leases.delete(id);
  if (leases.size >= 256)
    throw new Error("Too many active file previews. Close an existing preview first.");
  const id = randomUUID();
  leases.set(id, {
    target,
    token: parsed.token,
    preview: parsed.preview,
    expiresAt: Date.now() + LEASE_MS,
  });
  return { url: `familiaragent://app/_familiar/files/${id}` };
}

export function releaseFileStream(input: unknown): void {
  const { url } = z.object({ url: z.string().url() }).strict().parse(input);
  leases.delete(new URL(url).pathname.split("/").at(-1) ?? "");
}

export async function saveFileStream(input: unknown): Promise<{ saved: boolean }> {
  const { url, fileName } = z
    .object({ url: z.string().url(), fileName: z.string().min(1).max(255) })
    .strict()
    .parse(input);
  if (!url.startsWith("familiaragent://app/_familiar/files/"))
    throw new Error("Invalid file stream");
  const result = await dialog.showSaveDialog({ defaultPath: basename(fileName) });
  if (result.canceled || !result.filePath) {
    releaseFileStream({ url });
    return { saved: false };
  }
  const temporary = join(dirname(result.filePath), `.familiar-download-${randomUUID()}`);
  try {
    const response = await handleFileStream(new Request(url));
    if (!response.ok || !response.body) throw new Error(`Download failed (${response.status})`);
    await pipeline(
      Readable.fromWeb(response.body as unknown as Parameters<typeof Readable.fromWeb>[0]),
      createWriteStream(temporary, { flags: "wx", mode: 0o600 }),
    );
    await rename(temporary, result.filePath);
    return { saved: true };
  } finally {
    await rm(temporary, { force: true });
    releaseFileStream({ url });
  }
}

export async function handleFileStream(request: Request): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD")
    return new Response(null, { status: 405 });
  const id = new URL(request.url).pathname.split("/").at(-1) ?? "";
  const lease = leases.get(id);
  if (!lease || lease.expiresAt <= Date.now()) {
    leases.delete(id);
    return new Response("Preview expired. Reopen the file.", { status: 410 });
  }
  const proxy = lease.target.transportType === "ssh" ? await createSshProxy(lease.target) : null;
  const endpoint = proxy
    ? new URL(proxy.url.replace(/^ws:/u, "http:"))
    : new URL(lease.target.transportType === "tcp" ? lease.target.endpoint : "http://localhost");
  const path = `/api/files/download?token=${encodeURIComponent(lease.token)}${lease.preview ? "&preview=1" : ""}`;
  return new Promise<Response>((resolve, reject) => {
    const outgoing = (endpoint.protocol === "https:" ? httpsRequest : httpRequest)(
      {
        hostname: endpoint.hostname,
        port: endpoint.port || (endpoint.protocol === "https:" ? 443 : 80),
        ...(lease.target.transportType === "socket" || lease.target.transportType === "pipe"
          ? { socketPath: lease.target.transportPath }
          : {}),
        method: request.method,
        path,
        headers: request.headers.has("range") ? { Range: request.headers.get("range")! } : {},
        timeout: STREAM_TIMEOUT_MS,
      },
      (incoming) => {
        const headers = new Headers();
        for (const key of [
          "content-type",
          "content-length",
          "content-range",
          "accept-ranges",
          "content-disposition",
          "cache-control",
        ]) {
          const value = incoming.headers[key];
          if (typeof value === "string") headers.set(key, value);
        }
        incoming.once("close", () => {
          proxy?.close();
          request.signal.removeEventListener("abort", abort);
        });
        const body =
          request.method === "HEAD"
            ? null
            : (Readable.toWeb(incoming) as ReadableStream<Uint8Array>);
        if (!body) incoming.resume();
        resolve(new Response(body, { status: incoming.statusCode ?? 502, headers }));
      },
    );
    const abort = () => outgoing.destroy(new Error("File stream cancelled"));
    request.signal.addEventListener("abort", abort, { once: true });
    if (request.signal.aborted) abort();
    outgoing.once("timeout", () => outgoing.destroy(new Error("File stream timed out")));
    outgoing.once("error", (error) => {
      request.signal.removeEventListener("abort", abort);
      proxy?.close();
      reject(error);
    });
    outgoing.end();
  });
}
