import { createServer, request, type IncomingHttpHeaders, type Server } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { startLoopbackWebProxy } from "./web-proxy.js";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
});
async function listen(server: Server) {
  cleanup.push(() => {
    server.close();
    server.closeAllConnections();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture port");
  return address.port;
}
async function fixture(limits = {}) {
  const received: Array<{ url: string; headers: IncomingHttpHeaders; body: string }> = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    received.push({ url: req.url!, headers: req.headers, body });
    res.writeHead(201, { "content-type": "text/plain", "x-native-result": "preserved" });
    res.write("native ");
    res.end("response");
  });
  const tunnelPort = await listen(server);
  const proxy = await startLoopbackWebProxy({
    url: new URL("http://127.0.0.1:7434/?k=fixture-only"),
    tunnelPort,
    limits,
  });
  cleanup.push(proxy.close);
  return { proxy, received, origin: `http://127.0.0.1:${proxy.port}` };
}

describe("origin-preserving loopback proxy", () => {
  it("streams request/response while restoring only its own Host and Origin", async () => {
    const f = await fixture();
    const response = await fetch(f.origin + "/api/input?k=fixture%2Fkey", {
      method: "POST",
      headers: { origin: f.origin, "content-type": "text/plain", "x-pullboard-key": "fixture-key" },
      body: "native input",
    });
    expect(response.status).toBe(201);
    expect(response.headers.get("x-native-result")).toBe("preserved");
    expect(await response.text()).toBe("native response");
    expect(f.received).toHaveLength(1);
    expect(f.received[0]).toMatchObject({
      url: "/api/input?k=fixture%2Fkey",
      body: "native input",
      headers: {
        host: "127.0.0.1:7434",
        origin: "http://127.0.0.1:7434",
        "x-pullboard-key": "fixture-key",
      },
    });
  });
  it("rejects other origins and hostnames before they reach the original app", async () => {
    const f = await fixture();
    for (const origin of ["https://outside.example", "null", "http://127.0.0.1:7434"]) {
      const response = await fetch(f.origin, { headers: { origin } });
      expect(response.status).toBe(403);
      await response.text();
    }
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(f.origin, { headers: { host: "outside.example" } }, (res) => {
        res.resume();
        resolve(res.statusCode!);
      });
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(403);
    expect(f.received).toHaveLength(0);
  });
  it("permits initial navigation without fabricating an Origin and bounds request bodies", async () => {
    const f = await fixture({ maxRequestBytes: 4 });
    const response = await fetch(f.origin + "/?k=fixture-only");
    await response.text();
    expect(f.received[0]!.headers.origin).toBeUndefined();
    const tooLarge = await fetch(f.origin, { method: "POST", body: "12345" });
    expect(tooLarge.status).toBe(413);
    await tooLarge.text();
    expect(f.received).toHaveLength(1);
  });
  it("keeps idle SSE responses open and closes upstream requests when released", async () => {
    let disconnected!: () => void;
    let sendNext!: () => void;
    const gone = new Promise<void>((resolve) => {
      disconnected = resolve;
    });
    const server = createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: native\n\n");
      sendNext = () => res.write("data: later\n\n");
      req.on("close", disconnected);
    });
    const tunnelPort = await listen(server);
    const proxy = await startLoopbackWebProxy({
      url: new URL("http://127.0.0.1:7434/"),
      tunnelPort,
      limits: { requestTimeoutMs: 20 },
    });
    cleanup.push(proxy.close);
    const response = await fetch(`http://127.0.0.1:${proxy.port}/events`);
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: native\n\n");
    await delay(60);
    sendNext();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: later\n\n");
    proxy.close();
    await gone;
    expect(proxy.alive()).toBe(false);
    await expect(fetch(`http://127.0.0.1:${proxy.port}/`)).rejects.toThrow();
    await reader.cancel().catch(() => {});
  });
});
