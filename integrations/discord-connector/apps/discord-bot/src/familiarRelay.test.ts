import { expect, it } from "vitest";
import { PassThrough } from "node:stream";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createFamiliarRelayRunner, serveFamiliarRelay, validateRelayRequest } from "./familiarRelay.js";
it("rejects arbitrary CLI commands or file injection before execution", () => {
  const base = { type: "request", id: randomUUID(), timeoutMs: 1000 };
  expect(() => validateRelayRequest({ ...base, args: ["shell", "rm"] })).toThrow();
  expect(() => validateRelayRequest({ ...base, args: ["plugin", "call", "evil", "run", "--input-file", "/tmp/input", "--host", "local", "--json"], input: {} })).toThrow();
});
it("relays bounded JSON inputs through local private files, never remote paths, and closes pending requests", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "discord-relay-test-"));
  const request = new PassThrough(), response = new PassThrough();
  try {
    const cli = path.join(directory, "cli");
    await writeFile(cli, `#!${process.execPath}\nconst fs=require('node:fs'); const a=process.argv.slice(2); console.log(JSON.stringify({result:JSON.parse(fs.readFileSync(a[5],'utf8')),file:a[5]}));`); await chmod(cli, 0o700);
    const serving = serveFamiliarRelay(cli, request, response);
    const run = createFamiliarRelayRunner(response, request, () => {});
    const file = path.join(directory, "remote-input.json"); await writeFile(file, JSON.stringify({ sessionId: "test", input: "owned input" }));
    const value = await run(["plugin", "call", "familiar-workspace", "tools.run.start", "--input-file", file, "--host", "ssh://host", "--json"], 5000) as { result: unknown; file: string };
    expect(value.result).toEqual({ sessionId: "test", input: "owned input" }); expect(value.file).not.toBe(file);
    await run.close(); request.end(); await serving;
    await expect(readFile(value.file)).rejects.toThrow();
  } finally { request.destroy(); response.destroy(); await rm(directory, { recursive: true, force: true }); }
});
it("closes in-flight native CLI processes when its SSH input is destroyed", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "discord-relay-close-"));
  const request = new PassThrough(), response = new PassThrough();
  let pid: number | undefined;
  try {
    const cli = path.join(directory, "cli"), pidFile = path.join(directory, "pid");
    await writeFile(cli, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`); await chmod(cli, 0o700);
    const serving = serveFamiliarRelay(cli, request, response);
    request.write(`${JSON.stringify({ type: "request", id: randomUUID(), timeoutMs: 10000, args: ["agent", "stop", "owned-agent", "--host", "local", "--json"] })}\n`);
    for (let i = 0; i < 100; i++) {
      try { pid = Number(await readFile(pidFile, "utf8")); break; } catch { await new Promise(resolve => setTimeout(resolve, 10)); }
    }
    expect(pid).toBeGreaterThan(0);
    request.destroy(); await serving;
    expect(() => process.kill(pid!, 0)).toThrow();
  } finally {
    request.destroy(); response.destroy();
    if (pid) { try { process.kill(-pid, "SIGKILL"); } catch {} }
    await rm(directory, { recursive: true, force: true });
  }
});
