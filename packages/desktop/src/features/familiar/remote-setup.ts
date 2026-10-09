import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { readFile } from "node:fs/promises";
import { validatePort, validateSshHost } from "@getpaseo/protocol/ssh-transport";
import { z } from "zod";

export const REMOTE_SETUP_TIMEOUT_MS = 20 * 60 * 1000;
const OUTPUT_LIMIT = 24 * 1024;
const NODE_VERSION = "22.20.0";
const inputSchema = z
  .object({
    host: z
      .string()
      .min(1)
      .refine((value) => !/\s/u.test(value), "SSH host must not contain whitespace"),
    sshPort: z.number().int().min(1).max(65535).optional(),
    daemonPort: z.number().int().min(1).max(65535),
  })
  .strict();

function sshConnectionArgs(target: z.infer<typeof inputSchema>): string[] {
  const args = [
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "ConnectTimeout=15",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
  ];
  if (target.sshPort) args.push("-p", String(target.sshPort));
  args.push(validateSshHost(target.host));
  return args;
}

export function remoteSetupArgs(input: unknown): string[] {
  const target = inputSchema.parse(input);
  return [
    ...sshConnectionArgs(target),
    "sh",
    "-s",
    "--",
    String(validatePort(target.daemonPort, "Server port")),
    NODE_VERSION,
  ];
}

const installations = new Map<string, Promise<{ output: string; updateDeferred?: boolean }>>();
export function prepareRemoteServer(
  input: unknown,
  scriptPath: string,
): Promise<{ output: string; updateDeferred?: boolean }> {
  const target = inputSchema.parse(input);
  const key = JSON.stringify(target);
  const existing = installations.get(key);
  if (existing) return existing;
  const result = installRemote(target, scriptPath);
  installations.set(key, result);
  void result.finally(() => installations.delete(key)).catch(() => {});
  return result;
}
async function installRemote(
  input: unknown,
  scriptPath: string,
): Promise<{ output: string; updateDeferred?: boolean }> {
  const target = inputSchema.parse(input);
  const args = remoteSetupArgs(target);
  const directory = path.dirname(scriptPath);
  const hash = (await readFile(path.join(directory, "runtime.sha256"), "utf8")).trim();
  if (!/^[a-f0-9]{64}$/u.test(hash))
    throw new Error("The bundled FamiliarAgent runtime digest is invalid.");
  const script = await readFile(scriptPath, "utf8");
  const base = await runSsh(args, Readable.from([script]));
  const overlay = await readFile(path.join(directory, "apply-runtime.sh"), "utf8");
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  const uploadArgs = [...sshConnectionArgs(target), `sh -c ${quote(overlay)} sh ${hash}`];
  const applied = await runSsh(uploadArgs, createReadStream(path.join(directory, "runtime.tgz")));
  return {
    output: base.output + applied.output,
    updateDeferred: applied.output.includes("FAMILIAR_UPDATE_DEFERRED:"),
  };
}
function runSsh(
  args: string[],
  source: Readable,
): Promise<{ output: string; updateDeferred?: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn("ssh", args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let output = "";
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      source.destroy();
      if (error) child.kill("SIGTERM");
      if (error) reject(error);
      else resolve({ output });
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(
        new Error(
          "Remote setup timed out. The server may still be installing; check its status before retrying.",
        ),
      );
    }, REMOTE_SETUP_TIMEOUT_MS);
    const append = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-OUTPUT_LIMIT);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", (error) => finish(error));
    child.stdin.on("error", (error) => finish(error));
    child.on("close", (code) =>
      finish(
        code === 0
          ? undefined
          : new Error(`Remote setup failed (${code ?? "disconnected"}). ${output.trim()}`),
      ),
    );
    source.once("error", (error) => finish(error));
    source.pipe(child.stdin);
  });
}
