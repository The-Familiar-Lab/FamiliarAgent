import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { prepareCodegRuntime } from "./setup-runtime.js";

let root: string;
let child: ChildProcess | undefined;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "familiar-codeg-launch-"));
});
afterEach(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    const closed = new Promise<void>((resolve) => child!.once("close", () => resolve()));
    child.kill("SIGTERM");
    await closed;
  }
  child = undefined;
  await rm(root, { recursive: true, force: true });
});
async function launch(program: string) {
  const binary = path.join(root, "native-codeg");
  await writeFile(binary, `#!${process.execPath}\n${program}`);
  await chmod(binary, 0o700);
  const cwd = path.join(root, "project");
  await mkdir(cwd);
  const prepared = await prepareCodegRuntime({
    directory: root,
    profile: path.join(root, "private"),
    executable: binary,
    node: process.execPath,
    cwd,
  });
  const plan = prepared.plan;
  child = spawn(plan.command!, plan.args, { cwd: plan.cwd, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "",
    stderr = "";
  child.stdout!.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr!.on("data", (chunk) => {
    stderr += String(chunk);
  });
  return {
    output: () => ({ stdout, stderr }),
    tokenFile: prepared.settings[0]!.parameters.tokenFile,
  };
}
describe("Codeg native readiness announcement", () => {
  it("announces an authenticated silent original service without disclosing its token", async () => {
    const result = await launch(
      `const http=require('node:http');http.createServer((req,res)=>{if(req.method==='POST'&&req.url==='/api/health'&&req.headers.authorization==='Bearer '+process.env.CODEG_TOKEN)res.end('{"status":"ok"}');else{res.statusCode=401;res.end('{}');}}).listen(Number(process.env.CODEG_PORT),process.env.CODEG_HOST);`,
    );
    await expect
      .poll(() => result.output().stdout, { timeout: 5000 })
      .toMatch(/^Codeg view: http:\/\/127\.0\.0\.1:\d+\n$/u);
    const token = (await readFile(result.tokenFile, "utf8")).trim();
    expect(result.output().stdout + result.output().stderr).not.toContain(token);
    expect(child?.exitCode).toBeNull();
  });
  it("does not turn an early native failure into a ready view", async () => {
    const result = await launch(
      "process.stderr.write('native fixture failed');process.exitCode=7;",
    );
    const exitCode = await new Promise<number | null>((resolve) => child!.once("close", resolve));
    expect(exitCode).toBe(7);
    expect(result.output().stdout).not.toContain("Codeg view:");
    expect(result.output().stderr).toContain("native fixture failed");
  });
});
