import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
const { showSaveDialog } = vi.hoisted(() => ({ showSaveDialog: vi.fn() }));
vi.mock("electron", () => ({ dialog: { showSaveDialog } }));
import {
  handleFileStream,
  registerFileStream,
  releaseFileStream,
  saveFileStream,
} from "./file-stream.js";
let server: Server;
let endpoint: string;
let directory: string;
const payload = Buffer.from("media-test-payload");
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "familiar-stream-"));
  server = createServer((request, response) => {
    const ranged = request.headers.range === "bytes=2-5";
    const body = ranged ? payload.subarray(2, 6) : payload;
    response.writeHead(ranged ? 206 : 200, {
      "Content-Type": "video/mp4",
      "Content-Length": body.length,
      "Accept-Ranges": "bytes",
      ...(ranged ? { "Content-Range": `bytes 2-5/${payload.length}` } : {}),
    });
    response.end(request.method === "HEAD" ? undefined : body);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test address");
  endpoint = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    }),
  );
  await rm(directory, { recursive: true, force: true });
});
function lease() {
  return registerFileStream({
    target: { transportType: "tcp", endpoint },
    token: randomUUID(),
    preview: true,
  }).url;
}
it("streams seeking and HEAD without consuming a reusable preview", async () => {
  const url = lease();
  const head = await handleFileStream(new Request(url, { method: "HEAD" }));
  expect(head.headers.get("content-length")).toBe(String(payload.length));
  expect(await head.text()).toBe("");
  const range = await handleFileStream(new Request(url, { headers: { Range: "bytes=2-5" } }));
  expect(range.status).toBe(206);
  expect(await range.text()).toBe("dia-");
  expect(await (await handleFileStream(new Request(url))).text()).toBe(payload.toString());
  releaseFileStream({ url });
  expect((await handleFileStream(new Request(url))).status).toBe(410);
});
it("cancelling Save releases the lease and creates no file", async () => {
  const url = lease();
  showSaveDialog.mockResolvedValue({ canceled: true });
  expect(await saveFileStream({ url, fileName: "video.mp4" })).toEqual({ saved: false });
  expect(await readdir(directory)).toEqual([]);
  expect((await handleFileStream(new Request(url))).status).toBe(410);
});
it("saves complete bytes atomically and removes its temporary file", async () => {
  const url = lease();
  const filePath = path.join(directory, "video.mp4");
  showSaveDialog.mockResolvedValue({ canceled: false, filePath });
  expect(await saveFileStream({ url, fileName: "video.mp4" })).toEqual({ saved: true });
  expect(await readFile(filePath)).toEqual(payload);
  expect(await readdir(directory)).toEqual(["video.mp4"]);
});
it("rejects an already cancelled stream", async () => {
  const url = lease();
  const controller = new AbortController();
  controller.abort();
  await expect(handleFileStream(new Request(url, { signal: controller.signal }))).rejects.toThrow(
    "cancelled",
  );
  releaseFileStream({ url });
});
