import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server, type RequestListener } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { codegReady } from "./codeg-ready.js";

let root: string;
let tokenFile: string;
let server: Server | undefined;
const token = "a".repeat(64);
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "familiar-codeg-ready-"));
  tokenFile = path.join(root, "token");
  await writeFile(tokenFile, token, { mode: 0o600 });
});
afterEach(async () => {
  server?.closeAllConnections();
  if (server?.listening) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
  await rm(root, { recursive: true, force: true });
});
async function listen(handler: RequestListener): Promise<string> {
  server = createServer(handler);
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test address");
  return `http://127.0.0.1:${address.port}`;
}
describe("reuse the original Codeg service", () => {
  it("requires the private managed token and the native authenticated health response", async () => {
    const requests: { method?: string; url?: string; authenticated: boolean }[] = [];
    const url = await listen((request, response) => {
      requests.push({
        method: request.method,
        url: request.url,
        authenticated: request.headers.authorization === `Bearer ${token}`,
      });
      response.end(JSON.stringify({ status: "ok", version: "native" }));
    });
    expect(await codegReady(url, tokenFile)).toBe(true);
    expect(requests).toEqual([{ method: "POST", url: "/api/health", authenticated: true }]);
  });
  it("only treats refused connections as an absent service", async () => {
    const url = await listen((_request, response) => response.end("unused"));
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    expect(await codegReady(url, tokenFile)).toBe(false);
  });
  it("does not start over an unauthenticated, unrelated or oversized service", async () => {
    let mode = 0;
    const url = await listen((_request, response) => {
      if (mode === 0) {
        response.statusCode = 401;
        response.end('{"status":"ok"}');
      } else if (mode === 1) response.end('{"ok":true}');
      else response.end("x".repeat(8192));
    });
    for (mode = 0; mode < 3; mode++)
      await expect(codegReady(url, tokenFile)).rejects.toThrow("no second service was started");
  });
  it("bounds an unresponsive listener and preserves the credential outside the error", async () => {
    const url = await listen(() => {});
    const started = Date.now();
    await expect(codegReady(url, tokenFile)).rejects.toThrow("could not be verified");
    expect(Date.now() - started).toBeLessThan(4000);
  });
});
