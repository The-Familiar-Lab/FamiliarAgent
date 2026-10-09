import { createServer, request, type IncomingHttpHeaders } from "node:http";
import type { ClientRequest } from "node:http";

const DEFAULT_LIMITS = {
  maxConnections: 64,
  requestTimeoutMs: 30_000,
  maxRequestBytes: 8 * 1024 * 1024,
};
const HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function endToEndHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const connectionHeaders = new Set(
    (headers.connection ?? "").split(",").map((name) => name.trim().toLowerCase()),
  );
  return Object.fromEntries(
    Object.entries(headers).filter(
      ([name]) => !HOP_HEADERS.has(name) && !connectionHeaders.has(name),
    ),
  );
}

/** Keeps an original HTTP app's Host/Origin checks intact behind its SSH tunnel. */
export async function startLoopbackWebProxy(options: {
  url: URL;
  tunnelPort: number;
  limits?: Partial<typeof DEFAULT_LIMITS>;
}): Promise<{ port: number; alive(): boolean; close(): void }> {
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  const hostname = options.url.hostname === "[::1]" ? "::1" : "127.0.0.1";
  const upstreams = new Set<ClientRequest>();
  let closed = false;
  let localOrigin = "";
  let localHost = "";
  const server = createServer({ maxHeaderSize: 16 * 1024 }, (incoming, outgoing) => {
    const origin = incoming.headers.origin;
    if (
      closed ||
      incoming.headers.host !== localHost ||
      (origin !== undefined && origin !== localOrigin) ||
      !incoming.url?.startsWith("/") ||
      incoming.url.startsWith("//")
    ) {
      outgoing.writeHead(403).end("This web app requires its own local address and origin.");
      incoming.resume();
      return;
    }
    const declaredLength = Number(incoming.headers["content-length"] ?? 0);
    if (
      !Number.isSafeInteger(declaredLength) ||
      declaredLength < 0 ||
      declaredLength > limits.maxRequestBytes
    ) {
      outgoing.writeHead(413).end("Request body exceeds the local web limit.");
      incoming.resume();
      return;
    }
    if (upstreams.size >= limits.maxConnections) {
      outgoing.writeHead(503).end("Too many active local web requests.");
      incoming.resume();
      return;
    }
    const headers = endToEndHeaders(incoming.headers);
    headers.host = options.url.host;
    if (origin !== undefined) headers.origin = options.url.origin;
    const upstream = request({
      hostname,
      port: options.tunnelPort,
      method: incoming.method,
      path: incoming.url,
      headers,
    });
    upstreams.add(upstream);
    const fail = () => {
      if (outgoing.writableEnded || outgoing.destroyed) return;
      if (!outgoing.headersSent)
        outgoing.writeHead(502).end("The original web app is unavailable.");
      else outgoing.destroy();
    };
    upstream.once("error", fail);
    upstream.once("close", () => upstreams.delete(upstream));
    upstream.setTimeout(limits.requestTimeoutMs, () => upstream.destroy());
    upstream.once("response", (response) => {
      if (closed || outgoing.destroyed) {
        response.destroy();
        return;
      }
      if (response.headers["content-type"]?.split(";")[0]?.trim() === "text/event-stream")
        upstream.setTimeout(0);
      const responseHeaders = endToEndHeaders(response.headers);
      outgoing.writeHead(response.statusCode ?? 502, responseHeaders);
      response.once("error", () => outgoing.destroy());
      response.pipe(outgoing);
    });
    let bytes = 0;
    incoming.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > limits.maxRequestBytes) {
        incoming.unpipe(upstream);
        if (!outgoing.headersSent)
          outgoing.writeHead(413).end("Request body exceeds the local web limit.");
        upstream.destroy();
      }
    });
    incoming.once("aborted", () => upstream.destroy());
    incoming.once("error", () => upstream.destroy());
    outgoing.once("close", () => upstream.destroy());
    incoming.pipe(upstream);
  });
  server.maxConnections = limits.maxConnections;
  server.requestTimeout = limits.requestTimeoutMs;
  server.headersTimeout = limits.requestTimeoutMs;
  server.on("upgrade", (_request, socket) => socket.destroy());
  const close = () => {
    if (closed) return;
    closed = true;
    for (const upstream of upstreams) upstream.destroy();
    server.close();
    server.closeAllConnections();
  };
  server.on("error", close);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, hostname, () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Local web proxy could not start.");
    const url = new URL(options.url);
    url.port = String(address.port);
    localOrigin = url.origin;
    localHost = url.host;
    return { port: address.port, alive: () => !closed && server.listening, close };
  } catch {
    close();
    throw new Error("Local web proxy could not start.");
  }
}
